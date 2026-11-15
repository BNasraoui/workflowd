import { expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxStore } from "../../src/sandbox/store"
import { runStoreMigrations } from "../../src/store/migrations"
import { sandboxGithubFixture } from "./harness"

const policy = {
  alias: "fixture",
  repository: "fixture/repo",
  repositoryId: 12,
  installationId: 1,
  workflowSha: "a".repeat(40),
  appActorId: 56,
  agentImage: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
  privateBootstrap: { mode: "actions-native" as const, repositoryOwnerId: 1 },
}

test("active inventory is independent of completed history and follows status pages", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const queries: string[] = []
  let malformed = false
  fixture.publication(async (request) => {
    const url = new URL(request.url)
    if (!url.pathname.endsWith("/actions/runs")) return undefined
    const status = url.searchParams.get("status") ?? "history"
    queries.push(status)
    if (status === "history") return Response.json({ total_count: 1001, workflow_runs: [] })
    if (status !== "in_progress") return Response.json({ total_count: 0, workflow_runs: [] })
    const response = await fetch(`${fixture.apiUrl}repos/${policy.repository}/actions/runs/41`, {
      headers: { authorization: "token fixture-token" },
    })
    const run = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      await response.json(),
    )
    const page = Number(url.searchParams.get("page"))
    return Response.json({
      total_count: malformed && page === 2 ? -1 : 101,
      workflow_runs:
        page === 1
          ? Array.from({ length: 100 }, (_, i) => ({
              ...run,
              id: 100 + i,
              head_branch: `workflowd/leases/fixture-${i}`,
            }))
          : malformed
            ? []
            : [{ ...run }],
    })
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const inventory = yield* github.inventory(policy)
        expect(inventory).toHaveLength(101)
        expect(inventory.some((entry) => entry.run.id === 41)).toBe(true)
        expect(queries).not.toContain("history")
        expect(queries.filter((status) => status === "in_progress")).toHaveLength(2)
        expect(new Set(queries)).toEqual(
          new Set(["queued", "in_progress", "waiting", "pending", "requested"]),
        )
        malformed = true
        expect((yield* github.inventory(policy).pipe(Effect.result))._tag).toBe("Failure")
      }),
    )
  } finally {
    await fixture.close()
  }
})

test("inventory partition does not block known-run cancellation or fabricate termination", async () => {
  const fixture = await sandboxGithubFixture(policy)
  let partition = true
  fixture.publication(async (request) =>
    new URL(request.url).pathname.endsWith("/actions/runs") && partition
      ? new Response(null, { status: 503 })
      : undefined,
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const service = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "run",
          leaseId: "lease-1",
          policy,
          sourceSha: "d".repeat(40),
          now: Date.now(),
        })
        yield* store.beginStart("run")
        yield* store.recordRun("run", 41, 1)
        yield* store.beginRelease("run")
        expect((yield* service.reconcile([policy]).pipe(Effect.result))._tag).toBe("Failure")
        expect(fixture.cancellations).toEqual([41])
        expect((yield* store.read("run"))?.state).toBe("releasing")
        expect(fixture.refDeletes).toBe(0)
        fixture.failCancellation(503)
        expect((yield* service.reconcile([policy]).pipe(Effect.result))._tag).toBe("Failure")
        expect((yield* store.cleanupRuns())[0]?.state).toBe("pending")
        partition = false
        fixture.failCancellation(202)
        fixture.listRuns([])
        yield* TestClock.adjust("60 seconds")
        yield* service.reconcile([policy])
        expect((yield* store.read("run"))?.state).toBe("releasing")
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* service.reconcile([policy])
        expect((yield* store.read("run"))?.state).toBe("released")
        expect(fixture.refDeletes).toBe(1)
        yield* service.reconcile([policy])
        expect(fixture.refDeletes).toBe(1)
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
      ),
    )
  } finally {
    await fixture.close()
  }
})

test("retained cleanup uses a serial bounded batch and retries the oldest unconfirmed run", async () => {
  const fixture = await sandboxGithubFixture(policy)
  fixture.publication(async (request) =>
    new URL(request.url).pathname.endsWith("/actions/runs")
      ? new Response(null, { status: 503 })
      : undefined,
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const service = yield* makeSandboxLeaseService(github)
        for (let id = 41; id < 50; id++) {
          const leaseId = `lease-${id}`
          fixture.savedRun(id, { head_branch: `workflowd/leases/${leaseId}` })
          yield* store.request({
            runId: leaseId,
            leaseId,
            policy,
            sourceSha: "d".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart(leaseId)
          yield* store.recordRun(leaseId, id, 1)
          yield* store.beginRelease(leaseId)
        }
        expect((yield* service.reconcile([policy]).pipe(Effect.result))._tag).toBe("Failure")
        expect(fixture.cancellations).toHaveLength(8)
        expect(fixture.refDeletes).toBe(0)
        expect((yield* store.cleanupRuns()).every((row) => row.state === "pending")).toBe(true)
        expect((yield* service.reconcile([policy]).pipe(Effect.result))._tag).toBe("Failure")
        expect(fixture.cancellations[8]).toBe(49)
        expect(fixture.cancellations).toHaveLength(16)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
}, 10000)

test("bounded unobserved discovery rotates past retained uncertain leases", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const branches: string[] = []
  fixture.publication(async (request) => {
    const url = new URL(request.url)
    if (!url.pathname.endsWith("/actions/runs")) return undefined
    const branch = url.searchParams.get("branch")
    if (branch) branches.push(branch)
    return Response.json({ total_count: 0, workflow_runs: [] })
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const service = yield* makeSandboxLeaseService(github)
        for (let id = 1; id <= 9; id++) {
          const leaseId = `unobserved-${id}`
          yield* store.request({
            runId: leaseId,
            leaseId,
            policy,
            sourceSha: "d".repeat(40),
            now: Date.now(),
          })
          yield* store.beginRelease(leaseId)
        }
        yield* service.reconcile([policy])
        expect(new Set(branches).size).toBe(8)
        expect(yield* store.active()).toHaveLength(9)
        branches.length = 0
        yield* service.reconcile([policy])
        expect(branches[0]).toBe("workflowd/leases/unobserved-9")
        expect(new Set(branches).size).toBe(8)
        expect(yield* store.active()).toHaveLength(9)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("slow confirmed native runs release incrementally across bounded cleanup passes", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const removed: string[] = []
  fixture.listRuns([])
  fixture.publication(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === "DELETE" && path.includes("/git/refs/heads/"))
      removed.push(path.split("/").at(-1)!)
    return undefined
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const service = yield* makeSandboxLeaseService({
          ...github,
          savedRun: (...args) =>
            github.savedRun(...args).pipe(Effect.tap(() => Effect.sleep("8 seconds"))),
        })
        for (let id = 41; id < 49; id++) {
          const leaseId = `slow-${id}`
          fixture.savedRun(id, {
            head_branch: `workflowd/leases/${leaseId}`,
            status: "completed",
            conclusion: "cancelled",
          })
          yield* store.request({
            runId: leaseId,
            leaseId,
            policy,
            sourceSha: "d".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart(leaseId)
          yield* store.recordRun(leaseId, id, 1)
          yield* store.beginRelease(leaseId)
        }
        // Let real HTTP/SQLite I/O settle between small virtual-clock steps.
        yield* Effect.promise(() => Bun.sleep(10)).pipe(
          Effect.andThen(TestClock.adjust("100 millis")),
          Effect.forever,
          Effect.forkChild,
        )
        expect((yield* service.reconcile([policy]).pipe(Effect.result))._tag).toBe("Failure")
        // Seven successful exact reads must have advanced before the eighth was interrupted.
        expect(removed).toHaveLength(7)
        expect((yield* store.cleanupRuns()).map((row) => row.state)).toEqual(["pending"])
        expect((yield* store.active()).map((lease) => lease.run_id)).toEqual(["slow-48"])
        yield* service.reconcile([policy])
        expect(yield* store.active()).toHaveLength(0)
        expect(removed).toHaveLength(8)
        expect(new Set(removed).size).toBe(8)
        expect(fixture.cancellations).toHaveLength(0)
        yield* service.reconcile([policy])
        expect(removed).toHaveLength(8)
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    )
  } finally {
    await fixture.close()
  }
}, 15000)

test("workflow rollover fairly inventories both saved identities and recovers late visible runs", async () => {
  const next = { ...policy, workflowSha: "c".repeat(40) }
  const fixture = await sandboxGithubFixture(policy)
  const template = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    await fetch(`${fixture.apiUrl}repos/${policy.repository}/actions/runs/41`, {
      headers: { authorization: "token fixture-token" },
    }).then((response) => response.json()),
  )
  const runs = [policy, next].map((saved, index) => ({
    ...template,
    id: 41 + index,
    head_sha: saved.workflowSha,
    head_branch: `workflowd/leases/rollover-${index}`,
    status: "in_progress",
    conclusion: null as string | null,
  }))
  const inventories: string[] = []
  const deletions: string[] = []
  let visible = false
  fixture.publication(async (request) => {
    const url = new URL(request.url)
    if (request.method === "DELETE") deletions.push(url.pathname.split("/").at(-1)!)
    if (!url.pathname.endsWith("/actions/runs")) return undefined
    const query = url.searchParams
    if (!query.has("branch")) inventories.push(query.get("head_sha")!)
    const matching = visible
      ? runs.filter(
          (run) =>
            run.head_sha === query.get("head_sha") &&
            (query.has("branch")
              ? run.head_branch === query.get("branch")
              : run.status === query.get("status")),
        )
      : []
    return Response.json({ total_count: matching.length, workflow_runs: matching })
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const service = yield* makeSandboxLeaseService(github)
        for (const [index, saved] of [policy, next].entries()) {
          yield* store.request({
            runId: `rollover-${index}`,
            leaseId: `rollover-${index}`,
            policy: saved,
            sourceSha: "d".repeat(40),
            now: Date.now(),
          })
          yield* store.beginRelease(`rollover-${index}`)
        }
        for (let minute = 0; minute < 5; minute++) {
          if (minute) yield* TestClock.adjust("60 seconds")
          if (minute === 2) {
            visible = true
            for (const run of runs) fixture.savedRun(run.id, run)
          }
          if (minute === 4)
            for (const run of runs) {
              run.status = "completed"
              run.conclusion = "cancelled"
              fixture.savedRun(run.id, run)
            }
          yield* service.reconcile([next]).pipe(Effect.result)
          yield* service.reconcile([next]).pipe(Effect.result)
          const expected = minute % 2 === 0 ? next : policy
          expect(inventories.slice(minute * 5)).toEqual(Array<string>(5).fill(expected.workflowSha))
          if (minute < 4) expect(yield* store.active()).toHaveLength(2)
          if (minute === 1) expect(yield* store.cleanupRuns()).toHaveLength(0)
          if (minute === 3) {
            expect(new Set(fixture.cancellations)).toEqual(new Set([41, 42]))
            expect((yield* store.cleanupRuns()).map((row) => row.state)).toEqual([
              "pending",
              "pending",
            ])
            // The two pre-visibility wakes per identity recheck exact absence; live runs add none.
            expect(deletions).toHaveLength(4)
          }
        }
        expect(yield* store.active()).toHaveLength(0)
        expect((yield* store.cleanupRuns(true)).map((row) => row.state)).toEqual([
          "released",
          "released",
        ])
        expect(deletions.sort()).toEqual([
          "rollover-0",
          "rollover-0",
          "rollover-0",
          "rollover-1",
          "rollover-1",
          "rollover-1",
        ])
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    )
  } finally {
    await fixture.close()
  }
}, 15000)

test("interrupted inventory remains uncertain for its admission window while known cleanup progresses", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let inventories = 0
  fixture.listRuns([])
  fixture.savedRun(41, { head_branch: "workflowd/leases/known" })
  fixture.publication(async (request) => {
    const query = new URL(request.url)
    if (query.pathname.endsWith("/actions/runs") && !query.searchParams.has("branch")) {
      if (++inventories === 1) {
        entered.resolve()
        await resume.promise
      }
    }
    return undefined
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const service = yield* makeSandboxLeaseService(github)
        for (const runId of ["known", "unobserved"]) {
          yield* store.request({
            runId,
            leaseId: runId,
            policy,
            sourceSha: "d".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart(runId)
          if (runId === "known") yield* store.recordRun(runId, 41, 1)
          yield* store.beginRelease(runId)
        }
        const pending = yield* service.reconcile([policy]).pipe(Effect.forkScoped)
        yield* Effect.promise(() => entered.promise)
        yield* Fiber.interrupt(pending)
        resume.resolve()
        for (const advance of [0, 59999]) {
          yield* TestClock.adjust(advance)
          expect((yield* service.reconcile([policy]).pipe(Effect.result))._tag).toBe("Failure")
          expect(inventories).toBe(1)
          expect(yield* store.active()).toHaveLength(2)
          expect(fixture.refDeletes).toBe(0)
        }
        expect(fixture.cancellations).toEqual([41, 41])
        fixture.savedRun(41, {
          head_branch: "workflowd/leases/known",
          status: "completed",
          conclusion: "cancelled",
        })
        yield* TestClock.adjust(1)
        yield* service.reconcile([policy])
        expect(inventories).toBe(6)
        expect((yield* store.read("known"))?.state).toBe("released")
        expect((yield* store.read("unobserved"))?.state).toBe("operator_required")
        expect((yield* store.cleanupRuns(true)).map((row) => row.state)).toEqual(["released"])
        expect(fixture.refDeletes).toBe(2)
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    )
  } finally {
    resume.resolve()
    await fixture.close()
  }
}, 10000)

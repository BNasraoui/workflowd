import { legacySandboxUnit } from "./opencode-fixture"
import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Database } from "bun:sqlite"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { sandboxMigration, sandboxCleanupMigration } from "../../src/sandbox/migration"
import { makeSandboxStore } from "../../src/sandbox/store"
import { sandboxGithubFixture, dispatchRunnerFixture, sandboxCoordinatorProcess } from "./harness"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import { stopSandboxOpenCode } from "../../src/sandbox/opencode"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
}

test("lease sends heartbeats while a slow source initialization is still in progress", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const root = await mkdtemp(join(tmpdir(), "sandbox-heartbeats-"))
  const sha = "b".repeat(40)
  let heartbeats = 0
  try {
    await fixture.setReady({
      leaseId: "lease-1",
      repository: policy.repository,
      repositoryId: policy.repositoryId,
      workflowSha: policy.workflowSha,
      appActorId: policy.appActorId,
      runId: 41,
      attempt: 1,
      peerId: "peer-1",
      address: "100.64.0.1",
      claims: {
        aud: policy.tailscaleAudience,
        repository_id: String(policy.repositoryId),
        actor_id: String(policy.appActorId),
        ref: "refs/heads/workflowd/leases/lease-1",
        sha: policy.workflowSha,
        job_workflow_sha: policy.workflowSha,
        job_workflow_ref:
          policy.repository +
          "/.github/workflows/agent-sandbox.yml@refs/heads/workflowd/leases/lease-1",
        event_name: "push",
        runner_environment: "github-hosted",
        run_id: "41",
        run_attempt: "1",
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github, root, async (args) => {
          if (args[0] === "/usr/bin/tailscale")
            return JSON.stringify({
              Peer: {
                fixture: {
                  ID: "peer-1",
                  TailscaleIPs: ["100.64.0.1"],
                  Online: true,
                  Tags: ["tag:agent-runner"],
                  sshHostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture"],
                },
              },
            })
          if (args.at(-1)?.endsWith(" heartbeat")) {
            heartbeats++
            return ""
          }
          await new Promise((resolve) => setTimeout(resolve, 31000))
          return sha
        })
        yield* store.request({
          runId: "run-1",
          leaseId: "lease-1",
          policy,
          sourceSha: sha,
          now: Date.now(),
        })
        expect((yield* leases.acquire("run-1")).state).toBe("ready")
        expect(heartbeats).toBeGreaterThanOrEqual(2)
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* leases.release("run-1")
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
}, 45000)

test("empty custody adopts owned runner for cancellation, never acquisition", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* leases.reconcile([policy])
        expect(fixture.cancellations).toEqual([41])
        const rows = yield* store.active()
        expect(rows).toEqual([])
        const cleanup = yield* store.cleanupRuns()
        expect(cleanup).toHaveLength(1)
        expect(cleanup[0]).toMatchObject({
          state: "pending",
          actions_run_id: 41,
          actions_attempt: 1,
          lease_id: "lease-1",
        })
        expect((yield* Effect.result(leases.acquire("lease-1")))._tag).toBe("Failure")
        expect(fixture.refCreates).toBe(0)
        expect(fixture.refDeletes).toBe(0)
        fixture.listRuns([])
        yield* leases.reconcile([policy])
        expect(fixture.cancellations).toEqual([41, 41])
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* leases.reconcile([policy])
        expect(yield* store.cleanupRuns()).toEqual([])
        expect(fixture.refDeletes).toBe(1)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("every observed owned run remains in custody when duplicate runs share a lease ref", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        fixture.listRuns([{ id: 41 }, { id: 42 }])
        fixture.beforeCancel(async () => {
          expect(
            (await Effect.runPromise(store.cleanupRuns())).map((row) => row.actions_run_id),
          ).toEqual([41, 42])
        })
        yield* leases.reconcile([policy])
        expect(fixture.cancellations).toEqual([41, 42])
        // Only run 41 has ended. Eventual-consistency listings now omit run 42,
        // whose cancellation acknowledgement did not prove termination.
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        fixture.listRuns([])
        yield* leases.reconcile([policy])
        expect(fixture.refDeletes).toBe(0)
        expect((yield* store.cleanupRuns()).map((row) => row.actions_run_id)).toEqual([41, 42])
        expect(fixture.savedRunRequests).toContain(42)
        fixture.savedRun(42, { status: "completed", conclusion: "cancelled" })
        yield* leases.reconcile([policy])
        expect(fixture.refDeletes).toBe(1)
        expect(yield* store.cleanupRuns()).toEqual([])
        expect(yield* store.active()).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("repository inventory filters every foreign identity and paginates without losing custody", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    const foreign = [
      { repository: { id: 2, fork: false } },
      { repository: { id: policy.repositoryId, fork: true } },
      { head_repository: { id: 2, fork: false } },
      { head_repository: { id: policy.repositoryId, fork: true } },
      { actor: { id: 2 } },
      { triggering_actor: { id: 2 } },
      { event: "pull_request" },
      { head_sha: "b".repeat(40) },
      { run_attempt: 2 },
      { path: ".github/workflows/ci.yml" },
      { head_branch: "main" },
      { head_branch: "workflowd/leases/../bad" },
    ]
    fixture.listRuns(foreign.map((mutation, i) => ({ id: i + 1, ...mutation })))
    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        expect(yield* github.inventory(policy)).toEqual([])
        fixture.inventoryPages([
          {
            total: 101,
            runs: Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              path: ".github/workflows/ci.yml",
            })),
          },
          { total: 101, runs: [{ id: 101, head_branch: "workflowd/leases/orphan" }] },
        ])
        expect(
          (yield* github.inventory(policy)).map((owned) => [owned.leaseId, owned.run.id]),
        ).toEqual([["orphan", 101]])
        expect(fixture.inventoryRequests.slice(-2)).toEqual([1, 2])
      }),
    )
  } finally {
    await fixture.close()
  }
})

test("incomplete inventory preserves custody and errors without cancelling a partial page", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const full = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    head_branch: `workflowd/leases/lease-${i}`,
  }))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "active",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* store.beginStart("active")
        yield* store.recordRun("active", 41, 1)
        for (const pages of [
          [{ total: 1001, runs: full }],
          [
            { total: 101, runs: full },
            { total: 101, runs: [], status: 503 },
          ],
          [
            { total: 101, runs: full },
            { total: 102, runs: [{ id: 101 }] },
          ],
          [
            { total: 101, runs: full },
            { total: 101, runs: [{ id: 1 }] },
          ],
          [{ total: 2, runs: [{ id: 41 }] }],
          [{ total: 1, runs: [{ id: "malformed" }] }],
        ]) {
          fixture.inventoryPages(pages)
          const result = yield* Effect.result(leases.reconcile([policy]))
          expect(result._tag).toBe("Failure")
          expect(yield* store.active()).toHaveLength(1)
          expect((yield* store.read("active"))?.release_error).not.toBeNull()
          expect(fixture.cancellations).toEqual([])
          expect(fixture.refDeletes).toBe(0)
          expect((yield* Effect.result(leases.release("active")))._tag).toBe("Failure")
          expect((yield* Effect.result(leases.reconcile()))._tag).toBe("Failure")
          expect(fixture.cancellations).toEqual([])
        }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("file SQLite retains adopted custody across lost cancellation acknowledgements and restart", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const root = await mkdtemp(join(tmpdir(), "sandbox-orphan-restart-"))
  const database = () => SqliteClient.layer({ filename: join(root, "leases.sqlite") })
  try {
    fixture.failCancellation(502)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        expect((yield* Effect.result(leases.reconcile([policy])))._tag).toBe("Failure")
        const store = yield* makeSandboxStore
        expect((yield* store.cleanupRuns())[0]?.last_error).not.toBeNull()
      }).pipe(Effect.provide(database())),
    )
    fixture.failCancellation(202)
    fixture.listRuns([])
    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* leases.reconcile([policy])
        const store = yield* makeSandboxStore
        expect((yield* store.cleanupRuns())[0]?.state).toBe("pending")
        expect(fixture.cancellations).toEqual([41, 41])
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* leases.reconcile([policy])
        expect(yield* store.active()).toEqual([])
        expect(fixture.refDeletes).toBe(1)
      }).pipe(Effect.provide(database())),
    )
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("inventory never replaces active session or source custody", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "active",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* store.beginStart("active")
        yield* store.recordRun("active", 41, 1)
        yield* store.bind("active", 41, 1, {
          leaseId: "lease-1",
          peerId: "peer",
          address: "127.0.0.1",
          port: 22,
          repositoryPath: "/workspace/repository",
          knownHostsFile: "/tmp/key",
          identityFile: "/dev/null",
        })
        const before = yield* store.read("active")
        yield* leases.reconcile([policy])
        expect(yield* store.read("active")).toEqual(before)
        expect(fixture.cancellations).toEqual([])
        expect(fixture.refCreates).toBe(0)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

for (const scenario of ["lost cancellation acknowledgement", "ENOSPC", "lost endpoint file"])
  test(`killed coordinator recovers file custody after ${scenario} and stops the saved unit`, async () => {
    const fullControlDirectory = scenario === "ENOSPC"
    const runner = await dispatchRunnerFixture()
    const fixture = await sandboxGithubFixture(policy, runner.name)
    const database = join(runner.root, "coordinator.sqlite")
    const directory = join(runner.root, "control")
    await mkdir(directory, { mode: 0o700 })
    let server: Awaited<ReturnType<typeof legacySandboxUnit>> | undefined
    let coordinator: Awaited<ReturnType<typeof sandboxCoordinatorProcess>> | undefined
    const base = WorkflowStoreLive.pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: database })),
    )
    const layer = Layer.merge(AgentRunStoreLive, KernelSessionStoreLive).pipe(
      Layer.provideMerge(base),
    )
    try {
      server = await legacySandboxUnit(directory, runner.name)
      const endpoint = server
      await expect(
        stopSandboxOpenCode({ ...endpoint, invocationId: "0".repeat(32) }),
      ).rejects.toThrow("generation changed")
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeSandboxStore
          const runs = yield* AgentRunStore
          const sessions = yield* KernelSessionStore
          yield* runs.create({
            runId: "abandoned",
            route: "sandbox",
            providerId: "openai",
            modelId: "gpt-6-astra-fixture",
            agent: "sandbox",
            repository: policy.alias,
            directory,
            prompt: "Interrupted task",
            promptSha256: "b".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: new Date(),
          })
          yield* runs.claimSpawn({ runId: "abandoned", now: new Date() })
          yield* sessions.registerResource({
            resourceId: "resource",
            owningHostId: "mint",
            absolutePath: directory,
            kind: "workspace",
            createdAt: new Date(),
          })
          yield* sessions.registerSession({
            sessionId: "opencode-session-ses_abandoned",
            nativeSessionId: "ses_abandoned",
            resourceId: "resource",
            providerKind: "opencode",
            providerVersion: 1,
            providerId: "sandbox",
            serverId: "sandbox",
            endpointAlias: "sandbox",
            endpointIdentity: endpoint.url,
            owningHostId: "mint",
            createdAt: new Date(),
          })
          yield* runs.markSpawned({
            runId: "abandoned",
            nativeSessionId: "ses_abandoned",
            sessionId: "opencode-session-ses_abandoned",
            resourceId: "resource",
            now: new Date(),
          })
          yield* runs.markVerified({ runId: "abandoned", outputTokens: 1, now: new Date() })
          yield* store.request({
            runId: "abandoned",
            leaseId: runner.name,
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart("abandoned")
          yield* store.recordRun("abandoned", 41, 1)
          yield* store.bind("abandoned", 41, 1, runner.transport)
          yield* store.attachUnit("abandoned", endpoint.unit, endpoint.invocationId)
          yield* store.attachSession("abandoned", "ses_abandoned")
        }).pipe(Effect.provide(layer)),
      )
      if (scenario === "lost endpoint file") await rm(join(directory, "endpoint.json"))
      fixture.failCancellation(fullControlDirectory ? 202 : 502)
      const input = { database, policy, github: fixture.github, apiUrl: fixture.apiUrl }
      coordinator = await sandboxCoordinatorProcess({
        ...input,
        ...(fullControlDirectory ? { fullControlDirectory: directory } : {}),
      })
      if (fullControlDirectory) expect(coordinator.output).toContain("disk exhaustion verified")
      await coordinator.stop()
      coordinator = undefined
      expect(fixture.cancellations).toContain(41)
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeSandboxStore
          const lease = yield* store.read("abandoned")
          expect(lease?.state).toBe("releasing")
          expect(lease?.release_error).not.toBeNull()
          const runs = yield* AgentRunStore
          expect((yield* runs.read("abandoned"))?.state).toBe("verified")
        }).pipe(Effect.provide(layer)),
      )
      fixture.failCancellation(202)
      fixture.listRuns([])
      fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
      coordinator = await sandboxCoordinatorProcess(input)
      await coordinator.stop()
      coordinator = undefined
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeSandboxStore
          const runs = yield* AgentRunStore
          expect((yield* store.read("abandoned"))?.state).toBe("released")
          expect((yield* runs.read("abandoned"))?.state).toBe("operator_required")
          expect(fixture.refDeletes).toBe(1)
        }).pipe(Effect.provide(layer)),
      )
      await stopSandboxOpenCode(endpoint)
    } finally {
      await coordinator?.stop()
      await server?.close()
      await fixture.close()
      await runner.close()
    }
  }, 120000)

test("cleanup adoption is atomic, immutable and independent across repositories", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* sandboxMigration
      yield* sandboxCleanupMigration
      const store = yield* makeSandboxStore
      const first = { leaseId: "lease-1", run: { id: 41, run_attempt: 1 } }
      yield* store.adopt(policy, first, 100)
      yield* store.adopt(policy, first, 200)
      expect((yield* store.cleanupRuns())[0]?.observed_at).toBe(100)
      for (const [snapshot, owned] of [
        [{ ...policy, workflowSha: "c".repeat(40) }, first],
        [policy, { ...first, leaseId: "other" }],
        [policy, { ...first, leaseId: "../bad" }],
        [policy, { ...first, run: { id: 0, run_attempt: 1 } }],
        [policy, { ...first, run: { id: 41, run_attempt: 2 } }],
      ] as const)
        expect((yield* Effect.result(store.adopt(snapshot, owned, 200)))._tag).toBe("Failure")
      yield* store.adopt({ ...policy, repositoryId: 2, repository: "owner/other" }, first, 200)
      expect(yield* store.cleanupRuns()).toHaveLength(2)
      expect(yield* store.active()).toEqual([])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
})

test("active primary survives duplicate cleanup, then all saved runs gate release and later reuse", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "active",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* store.beginStart("active")
        yield* store.recordRun("active", 41, 1)
        yield* store.bind("active", 41, 1, {
          leaseId: "lease-1",
          peerId: "peer",
          address: "127.0.0.1",
          port: 22,
          repositoryPath: "/workspace/repository",
          knownHostsFile: "/tmp/key",
          identityFile: "/dev/null",
        })
        yield* store.attachUnit("active", "unit", "invocation")
        yield* store.attachSession("active", "session")
        const before = yield* store.read("active")
        fixture.listRuns([{ id: 41 }, { id: 42 }])
        yield* leases.reconcile([policy])
        expect(fixture.cancellations).toEqual([42])
        expect(yield* store.read("active")).toEqual(before)
        fixture.savedRun(42, { status: "completed", conclusion: "cancelled" })
        fixture.listRuns([])
        yield* leases.reconcile([policy])
        expect(fixture.refDeletes).toBe(0)
        yield* leases.release("active")
        expect(fixture.cancellations).toEqual([42, 41])
        for (const [mutation, status] of [
          [{}, 404],
          [{ actor: { id: 2 } }, 200],
          [{ run_attempt: 2 }, 200],
          [{ id: 99 }, 200],
          [{}, 503],
        ] as const) {
          fixture.savedRun(42, mutation, status)
          expect((yield* Effect.result(leases.release("active")))._tag).toBe("Failure")
          expect(fixture.refDeletes).toBe(0)
          expect(
            (yield* store.cleanupRuns()).find((row) => row.actions_run_id === 42)?.last_error,
          ).not.toBeNull()
        }
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        fixture.savedRun(42, { status: "completed", conclusion: "cancelled" })
        yield* leases.release("active")
        expect((yield* store.read("active"))?.state).toBe("released")
        expect(fixture.refDeletes).toBe(1)
        fixture.listRuns([{ id: 43 }])
        yield* leases.reconcile([policy])
        expect(fixture.cancellations.at(-1)).toBe(43)
        expect((yield* store.read("active"))?.state).toBe("releasing")
        expect(fixture.refDeletes).toBe(1)
        fixture.savedRun(43, { status: "completed", conclusion: "cancelled" })
        fixture.listRuns([])
        yield* leases.reconcile([policy])
        expect(fixture.refDeletes).toBe(2)
        expect(yield* store.cleanupRuns()).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("ref deletion requires confirmation and retries lost replies with retained custody", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* github.ensureRef(policy, "lease-1")
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        fixture.deleteResponse(204, true)
        expect((yield* Effect.result(leases.reconcile([policy])))._tag).toBe("Failure")
        expect((yield* store.cleanupRuns())[0]).toMatchObject({ state: "terminated" })
        fixture.deleteResponse(502)
        expect((yield* Effect.result(leases.reconcile([policy])))._tag).toBe("Failure")
        expect((yield* store.cleanupRuns())[0]?.last_error).not.toBeNull()
        fixture.listRuns([])
        fixture.deleteResponse(404)
        yield* leases.reconcile([policy])
        expect(yield* store.cleanupRuns()).toEqual([])
        expect(fixture.refDeletes).toBe(3)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("ref deletion fences concurrent adoption through the SQLite write transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-fence-"))
  const file = join(root, "custody.sqlite")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const sql = yield* SqlClient.SqlClient
        const store = yield* makeSandboxStore
        yield* store.adopt(policy, { leaseId: "lease-1", run: { id: 41, run_attempt: 1 } }, 100)
        const [row] = yield* store.cleanupRuns()
        if (!row) throw new Error("missing custody")
        yield* store.cleanupState(row, "terminated")
        const contender = new Database(file)
        try {
          yield* store.finishCleanup(
            row,
            Effect.sync(() => {
              expect(() =>
                contender
                  .query(
                    "INSERT INTO sandbox_cleanup_runs SELECT repository_id,42,1,lease_id,policy,'pending',200,200,NULL FROM sandbox_cleanup_runs LIMIT 1",
                  )
                  .run(),
              ).toThrow("locked")
            }),
          )
          yield* store.adopt(policy, { leaseId: "lease-1", run: { id: 42, run_attempt: 1 } }, 200)
          expect(
            yield* sql`SELECT actions_run_id,state FROM sandbox_cleanup_runs ORDER BY actions_run_id`,
          ).toEqual([
            { actions_run_id: 41, state: "released" },
            { actions_run_id: 42, state: "pending" },
          ])
        } finally {
          contender.close()
        }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: file }))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed direct read retains its run without preventing cancellation of the other saved run", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        fixture.listRuns([{ id: 41 }, { id: 42 }])
        fixture.savedRun(41, {}, 404)
        expect((yield* Effect.result(leases.reconcile([policy])))._tag).toBe("Failure")
        expect(fixture.cancellations).toEqual([42])
        expect(yield* store.cleanupRuns()).toHaveLength(2)
        expect(fixture.refDeletes).toBe(0)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("direct release only cleans the repository policy whose inventory it confirmed", async () => {
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "run-1",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* store.beginStart("run-1")
        yield* store.recordRun("run-1", 41, 1)
        yield* store.adopt(
          { ...policy, repository: "owner/other", repositoryId: 2 },
          { leaseId: "lease-2", run: { id: 42, run_attempt: 1 } },
          Date.now(),
        )
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        expect((yield* Effect.result(leases.release("run-1")))._tag).toBe("Success")
        expect((yield* store.read("run-1"))?.state).toBe("released")
        expect((yield* store.cleanupRuns()).map((row) => row.repository_id)).toEqual([2])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { parseSandboxRepositories } from "../../src/sandbox/config"
import {
  sandboxMigration,
  sandboxCleanupMigration,
  sandboxOperationMigration,
  sandboxCreationMigration,
} from "../../src/sandbox/migration"
import { makeSandboxStore } from "../../src/sandbox/store"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  tailscaleClientId: "THoBEY9Hwh11CNTRL-k4vtf1dX8811CNTRL",
  tailscaleAudience: "api.tailscale.com/THoBEY9Hwh11CNTRL-k4vtf1dX8811CNTRL",
}

function readiness(sourcePolicy = policy) {
  return {
    leaseId: "lease-1",
    repository: sourcePolicy.repository,
    repositoryId: sourcePolicy.repositoryId,
    workflowSha: sourcePolicy.workflowSha,
    appActorId: sourcePolicy.appActorId,
    runId: 41,
    attempt: 1,
    peerId: "peer-1",
    address: "100.64.0.1",
    claims: {
      aud: sourcePolicy.tailscaleAudience,
      repository_id: String(sourcePolicy.repositoryId),
      actor_id: String(sourcePolicy.appActorId),
      ref: "refs/heads/workflowd/leases/lease-1",
      sha: sourcePolicy.workflowSha,
      job_workflow_sha: sourcePolicy.workflowSha,
      job_workflow_ref: `${sourcePolicy.repository}/.github/workflows/agent-sandbox.yml@refs/heads/workflowd/leases/lease-1`,
      event_name: "push",
      runner_environment: "github-hosted",
      run_id: "41",
      run_attempt: "1",
    },
  }
}

test("sandbox policy rejects ambiguous aliases, mutable workflow refs and foreign repository names", () => {
  expect(parseSandboxRepositories(undefined)).toEqual([])
  expect(parseSandboxRepositories(JSON.stringify([policy]))).toEqual([policy])
  for (const value of [
    [policy, policy],
    [{ ...policy, workflowSha: "main" }],
    [{ ...policy, repository: "https://github.com/BNasraoui/workflowd" }],
    [{ ...policy, repositoryId: 0 }],
    [{ ...policy, tailscaleAudience: "" }],
  ])
    expect(() => parseSandboxRepositories(JSON.stringify(value))).toThrow()
})

test("SQLite preserves immutable lease intent and refuses premature release", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* sandboxMigration
      yield* sandboxCleanupMigration
      yield* sandboxOperationMigration
      yield* sandboxCreationMigration
      const store = yield* makeSandboxStore
      const input = {
        runId: "run-1",
        leaseId: "lease-1",
        policy,
        sourceSha: "b".repeat(40),
        now: 1000,
      }
      const first = yield* store.request(input)
      expect(first.state).toBe("requested")
      expect((yield* store.request({ ...input, leaseId: "lease-duplicate" })).lease_id).toBe(
        "lease-1",
      )
      const changed = yield* Effect.result(store.request({ ...input, sourceSha: "c".repeat(40) }))
      expect(changed._tag).toBe("Failure")
      expect((yield* store.read("run-1"))?.source_sha).toBe(input.sourceSha)
      expect((yield* Effect.result(store.confirmReleased("run-1")))._tag).toBe("Failure")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
})

test("GitHub acquisition scopes the token, reconciles a lost ref response, and fences run identity", async () => {
  const { sandboxGithubFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        yield* github.ensureRef(policy, "lease-1")
        yield* github.ensureRef(policy, "lease-1")
        expect(fixture.refCreates).toBe(1)
        expect(fixture.tokenRequests[0]).toEqual({
          repository_ids: [policy.repositoryId],
          permissions: { contents: "write", actions: "write" },
        })
        const runs = yield* github.runs(policy, "lease-1")
        expect(runs.map((run) => run.id)).toEqual([41])
        for (const mutation of [
          { head_sha: "f".repeat(40) },
          { head_branch: "main" },
          { actor: { id: 999 } },
          { triggering_actor: { id: 999 } },
          { repository: { id: 999, fork: false } },
          { head_repository: { id: policy.repositoryId, fork: true } },
          { run_attempt: 2 },
        ]) {
          fixture.mutateRun(mutation)
          expect((yield* Effect.result(github.runs(policy, "lease-1")))._tag).toBe("Failure")
        }
      }),
    )
  } finally {
    await fixture.close()
  }
})

test.each([
  "/access_tokens",
  `/repos/${policy.repository}`,
  "/git/ref/heads/workflowd/leases/lease-1",
])("GitHub request deadline aborts the transport at %s", async (path) => {
  const { Fiber } = await import("effect")
  const { TestClock } = await import("effect/testing")
  const { sandboxGithubFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const fixture = await sandboxGithubFixture(policy)
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  const client = fixture.OctokitClass.defaults({
    request: {
      fetch: (input: string | Request | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname.endsWith(path)) {
          signal = init?.signal
          entered.resolve()
          return response.promise
        }
        return fetch(input, init)
      },
    },
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeSandboxGithub(fixture.github, client)
        const fiber = yield* github
          .ensureRef(policy, "lease-1")
          .pipe(Effect.timeout("11 seconds"), Effect.result, Effect.forkChild)
        yield* Effect.promise(() => entered.promise)
        yield* TestClock.adjust("10 seconds")
        expect(signal?.aborted).toBe(true)
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure")
        expect(fixture.refCreates).toBe(0)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  } finally {
    response.resolve(new Response(null, { status: 503 }))
    await fixture.close()
  }
})

test("release stays pending until the correlated Actions run is confirmed completed", async () => {
  const { sandboxGithubFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const { makeSandboxLeaseService } = await import("../../src/sandbox/lease")
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const service = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "run-1",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* service.acquire("run-1")
        expect((yield* store.read("run-1"))?.state).toBe("starting")
        yield* service.release("run-1")
        expect((yield* store.read("run-1"))?.state).toBe("releasing")
        expect(fixture.refDeletes).toBe(0)
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* service.reconcile()
        expect((yield* store.read("run-1"))?.state).toBe("released")
        expect(fixture.refDeletes).toBe(1)
        expect((yield* Effect.result(service.acquire("run-1")))._tag).toBe("Failure")
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test.each([
  "before-ref",
  "without-run",
  "late-run",
  "late-on-delete",
  "ref-retained",
  "partial-inventory",
])(
  "unobserved run cleanup retains actionable custody and removes the exact ref (%s)",
  async (mode) => {
    const { sandboxGithubFixture } = await import("./harness")
    const { makeSandboxGithub } = await import("../../src/sandbox/github")
    const { makeSandboxLeaseService } = await import("../../src/sandbox/lease")
    const fixture = await sandboxGithubFixture(policy)
    fixture.listRuns([])
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* sandboxMigration
          yield* sandboxCleanupMigration
          yield* sandboxOperationMigration
          yield* sandboxCreationMigration
          const store = yield* makeSandboxStore
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const leases = yield* makeSandboxLeaseService(github)
          yield* store.request({
            runId: "no-run",
            leaseId: "lease-1",
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now(),
          })
          if (mode !== "before-ref") yield* leases.acquire("no-run")
          if (mode === "ref-retained") fixture.deleteResponse(422, true)
          if (mode === "partial-inventory") fixture.inventoryPages([{ total: 1, runs: [] }])
          expect((yield* Effect.result(leases.release("no-run")))._tag).toBe(
            mode === "partial-inventory" ? "Failure" : "Success",
          )
          for (let i = 0; i < 3; i++) {
            expect((yield* Effect.result(leases.reconcile([policy])))._tag).toBe(
              mode === "partial-inventory" ? "Failure" : "Success",
            )
          }
          const lease = yield* store.read("no-run")
          expect(lease?.state).toBe("operator_required")
          expect(lease?.release_error).toContain("Actions run unobserved")
          expect(lease?.release_error).toContain("refs/heads/workflowd/leases/lease-1")
          expect(lease?.release_error).toContain(policy.repository)
          expect(lease?.actions_run_id).toBeNull()
          expect(yield* store.cleanupRuns(true)).toHaveLength(0)
          expect(fixture.refCreates).toBe(mode === "before-ref" ? 0 : 1)
          if (mode === "partial-inventory") expect(fixture.refDeletes).toBe(0)
          else expect(fixture.refDeletes).toBeGreaterThan(0)
          const response = yield* Effect.tryPromise(() =>
            fetch(
              `${fixture.apiUrl}repos/${policy.repository}/git/ref/heads/workflowd/leases/lease-1`,
              { headers: { Authorization: "Bearer fixture-token" } },
            ),
          )
          const uncertain = mode === "ref-retained" || mode === "partial-inventory"
          expect(response.status).toBe(uncertain ? 200 : 404)
          expect(lease?.release_error).toContain(uncertain ? "unconfirmed" : "absence confirmed")
          expect((yield* Effect.result(leases.acquire("no-run")))._tag).toBe("Failure")
          if (mode === "late-run" || mode === "late-on-delete") {
            if (mode === "late-on-delete") fixture.afterRefDelete(() => fixture.listRuns([{}]))
            else fixture.listRuns([{}])
            yield* leases.reconcile([policy])
            expect(fixture.cancellations).toContain(41)
            expect((yield* store.read("no-run"))?.state).toBe("releasing")
            fixture.afterRefDelete(() => {})
            fixture.listRuns([])
            fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
            yield* leases.reconcile([policy])
            expect((yield* store.read("no-run"))?.state).toBe("released")
            expect(fixture.savedRunRequests).toContain(41)
            expect((yield* store.cleanupRuns(true))[0]?.state).toBe("released")
            expect(fixture.refCreates).toBe(1)
          }
          if (uncertain) {
            fixture.deleteResponse(204)
            fixture.inventoryPages([{ total: 0, runs: [] }])
            yield* leases.reconcile([policy])
            expect((yield* store.read("no-run"))?.release_error).toContain("absence confirmed")
          }
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      )
    } finally {
      await fixture.close()
    }
  },
)

test("readiness metadata must match the repository, lease, run and OIDC claims", async () => {
  const { sandboxGithubFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const fixture = await sandboxGithubFixture(policy)
  const ready = readiness()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        expect(yield* github.readiness(policy, "lease-1", 41, 1)).toBeNull()
        yield* Effect.tryPromise(() => fixture.setReady(ready))
        expect((yield* github.readiness(policy, "lease-1", 41, 1))?.peerId).toBe("peer-1")
        for (const mutation of [
          { leaseId: "foreign" },
          { repositoryId: 1 },
          { runId: 42 },
          { claims: { ...ready.claims, aud: "foreign" } },
        ]) {
          yield* Effect.tryPromise(() => fixture.setReady({ ...ready, ...mutation }))
          expect((yield* Effect.result(github.readiness(policy, "lease-1", 41, 1)))._tag).toBe(
            "Failure",
          )
        }
      }),
    )
  } finally {
    await fixture.close()
  }
})

test.each([204, 404, 422])(
  "DELETE %s requires an exact absent-ref confirmation",
  async (status) => {
    const { sandboxGithubFixture } = await import("./harness")
    const { makeSandboxGithub } = await import("../../src/sandbox/github")
    const fixture = await sandboxGithubFixture(policy)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          yield* github.ensureRef(policy, "lease-1")
          fixture.deleteResponse(status, true)
          expect((yield* Effect.result(github.deleteRef(policy, "lease-1")))._tag).toBe("Failure")
          fixture.deleteResponse(status)
          expect((yield* Effect.result(github.deleteRef(policy, "lease-1")))._tag).toBe("Success")
        }),
      )
    } finally {
      await fixture.close()
    }
  },
)

test("peer binding rejects a different authenticated node even when its address matches", async () => {
  const { bindSandboxPeer } = await import("../../src/sandbox/lease")
  const expected = { peerId: "peer-1", address: "100.64.0.1", leaseId: "lease-1" }
  const peer = {
    ID: "peer-1",
    TailscaleIPs: [expected.address],
    Tags: ["tag:agent-runner"],
    Online: true,
    sshHostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture"],
  }
  expect(bindSandboxPeer(expected, { Peer: { key: peer } })).toEqual(peer.sshHostKeys)
  for (const mutation of [
    { ID: "peer-2" },
    { Tags: [] },
    { Online: false },
    { TailscaleIPs: ["100.64.0.2"] },
    { sshHostKeys: ["bad\nssh-rsa bad"] },
    { sshHostKeys: undefined },
    { sshHostKeys: [] },
  ]) {
    expect(() => bindSandboxPeer(expected, { Peer: { key: { ...peer, ...mutation } } })).toThrow()
  }
})

test("application configuration requires known aliases and exposes the sandbox policy", async () => {
  const { loadConfig } = await import("../../src/config")
  const env = {
    WORKFLOWD_MODE: "execution",
    WORKFLOWD_AGENT_RUN_TOKEN: "test-token",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/tmp/repo",
    WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES: JSON.stringify([policy]),
  }
  expect((await loadConfig(env)).agentRuns?.sandboxRepositories).toEqual([policy])
  await expect(
    loadConfig({ ...env, WORKFLOWD_AGENT_RUN_REPOSITORIES: "foreign=/tmp/repo" }),
  ).rejects.toThrow("sandbox alias")
  await expect(loadConfig({ ...env, WORKFLOWD_AGENT_RUN_TOKEN: undefined })).rejects.toThrow(
    "TOKEN is required",
  )
})

test("normal application migrations install the lease store", async () => {
  const { runStoreMigrations } = await import("../../src/store/migrations")
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeSandboxStore
      expect(yield* store.read("absent")).toBeNull()
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
})

test("the live probe fails closed before acquisition without an operator policy", async () => {
  const child = Bun.spawn(
    [process.execPath, "scripts/evidence/agent-sandbox.mjs", "--probe-lease"],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(await child.exited).toBe(1)
  expect(await new Response(child.stderr).text()).toContain(
    "WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES is required",
  )
})

test("restart release checks the saved run even when listings contain only a completed duplicate", async () => {
  const { sandboxGithubFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const { makeSandboxLeaseService } = await import("../../src/sandbox/lease")
  const fixture = await sandboxGithubFixture(policy)
  const root = await mkdtemp(join(tmpdir(), "sandbox-restart-"))
  const database = () => SqliteClient.layer({ filename: join(root, "leases.sqlite") })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
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
        yield* leases.acquire("run-1")
        yield* store.beginRelease("run-1")
      }).pipe(Effect.provide(database())),
    )
    fixture.listRuns([{ id: 42, status: "completed", conclusion: "cancelled" }])
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* leases.reconcile()
        expect((yield* store.read("run-1"))?.state).toBe("releasing")
        expect(fixture.cancellations).toContain(41)
        expect(fixture.refDeletes).toBe(0)
        fixture.mutateRun({ run_attempt: 2, status: "completed" })
        expect((yield* Effect.result(leases.release("run-1")))._tag).toBe("Failure")
        expect((yield* store.read("run-1"))?.release_error).not.toBeNull()
        expect(fixture.refDeletes).toBe(0)
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        fixture.listRuns([])
        yield* leases.reconcile()
        expect((yield* store.read("run-1"))?.state).toBe("released")
        expect(fixture.refDeletes).toBe(1)
      }).pipe(Effect.provide(database())),
    )
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("the operator trust record accepts no custom claims and validates before acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-policy-"))
  const trust = {
    clientId: policy.tailscaleClientId,
    audience: policy.tailscaleAudience,
    issuer: "https://token.actions.githubusercontent.com",
    repositoryOwnerId: 81005232,
    subject: "repo:BNasraoui@81005232/workflowd@1306107007:ref:refs/heads/workflowd/leases/*",
    customClaims: {},
    runnerInitiatedTailnetConnections: "deny",
    mintInitiatedSsh: "allow",
    refRestriction: {
      ruleset: 24498610,
      soleBypassApp: 4337845,
      pattern: "workflowd/leases/**",
      operations: ["create", "update", "delete", "non_fast_forward"],
    },
  }
  const path = join(root, "trust.json")
  const run = async () => {
    const child = Bun.spawn(
      [process.execPath, "scripts/evidence/agent-sandbox.mjs", "--check-policy"],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES: JSON.stringify([policy]),
          EVIDENCE_TAILSCALE_TRUST_FILE: path,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    return {
      status: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    }
  }
  try {
    await writeFile(path, JSON.stringify(trust))
    const valid = await run()
    expect(valid).toEqual({
      status: 0,
      stdout: "Sandbox operator policy is compatible; enforcement remains unverified\n",
      stderr: "",
    })
    await writeFile(path, JSON.stringify({ ...trust, customClaims: { actor_id: "unexpected" } }))
    expect((await run()).status).toBe(1)
    await writeFile(path, JSON.stringify({ ...trust, subject: "repo:foreign/*" }))
    expect((await run()).status).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("lease acquisition initializes through SSH and retries a lost initialization reply", async () => {
  const { sandboxGithubFixture, leaseRunnerFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const { makeSandboxLeaseService } = await import("../../src/sandbox/lease")
  const runner = await leaseRunnerFixture(policy.repository)
  const fixture = await sandboxGithubFixture(policy)
  let loseReply = true
  let initializeCalls = 0
  const controlErrors: string[] = []
  const control = async (args: ReadonlyArray<string>, input: string, signal: AbortSignal) => {
    const result = await runner.control(args, input, signal).catch((error: unknown) => {
      controlErrors.push(String(error))
      throw error
    })
    if (args.at(-1)?.endsWith(" initialize")) {
      initializeCalls++
      if (loseReply) {
        loseReply = false
        throw new Error("Lost SSH reply after source initialization")
      }
    }
    return result
  }
  try {
    await fixture.setReady(readiness())
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github, join(runner.root, "control"), control)
        expect((yield* Effect.result(leases.acquire("missing")))._tag).toBe("Failure")
        expect(fixture.refCreates).toBe(0)
        yield* store.request({
          runId: "run-1",
          leaseId: "lease-1",
          policy,
          sourceSha: runner.sourceSha,
          now: Date.now(),
        })
        fixture.listRuns([{ id: 41 }, { id: 42 }])
        expect((yield* Effect.result(leases.acquire("run-1")))._tag).toBe("Failure")
        expect(initializeCalls).toBe(0)
        fixture.listRuns([{ id: 41 }])
        expect((yield* Effect.result(leases.acquire("run-1")))._tag).toBe("Failure")
        expect(controlErrors).toEqual([])
        expect(initializeCalls).toBe(1)
        expect((yield* store.read("run-1"))?.state).toBe("starting")
        const lease = yield* leases.acquire("run-1")
        expect(lease.state).toBe("ready")
        expect(lease.peer_id).toBe("peer-1")
        expect(lease.source_sha).toBe(runner.sourceSha)
        expect(lease.policy.workflowSha).not.toBe(runner.sourceSha)
        expect((yield* leases.acquire("run-1")).transport).toEqual(lease.transport)
        expect(initializeCalls).toBe(2)
        yield* leases.release("run-1")
        expect((yield* store.read("run-1"))?.state).toBe("releasing")
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        yield* leases.reconcile()
        expect((yield* store.read("run-1"))?.state).toBe("releasing")
        expect(fixture.cancellations).toContain(42)
        fixture.savedRun(42, { status: "completed", conclusion: "cancelled" })
        yield* leases.reconcile()
        expect((yield* store.read("run-1"))?.state).toBe("released")
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(runner.root, "leases.sqlite") }))),
    )
    expect(
      await runner.docker(
        "exec",
        "-u",
        "runner",
        `${runner.name}-runner`,
        "git",
        "rev-parse",
        "HEAD",
      ),
    ).toBe(runner.sourceSha)
  } finally {
    await fixture.close()
    await runner.close()
  }
}, 120000)

test("live probe releases its lease when acquisition fails in the Effect error channel", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { Effect } from "effect"
    import { probeLease } from "./scripts/evidence/agent-sandbox.mjs"
    let released = false
    const leases = {
      acquire: () => Effect.fail(new Error("peer binding refused")),
      release: () => Effect.sync(() => { released = true }),
    }
    const store = { read: () => Effect.succeed({state: released ? "released" : "starting"}) }
    const result = await Effect.runPromise(Effect.result(probeLease(leases, store, "probe")))
    console.log(JSON.stringify({released, result: result._tag}))
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toBe("")
  expect(JSON.parse(stdout)).toEqual({ released: true, result: "Failure" })
})

test("released custody is revalidated through direct saved runs and absent refs without acquisition", async () => {
  const { sandboxGithubFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const { makeSandboxLeaseService } = await import("../../src/sandbox/lease")
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "old",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* leases.acquire("old")
        fixture.listRuns([{ id: 41 }, { id: 42 }])
        fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
        fixture.savedRun(42, { status: "completed", conclusion: "cancelled" })
        yield* leases.release("old")
        const before = yield* store.read("old")
        expect(before?.state).toBe("released")
        fixture.listRuns([])
        fixture.deleteResponse(422)
        const created = fixture.refCreates
        const reads = fixture.savedRunRequests.length
        yield* leases.revalidateReleased()
        expect(fixture.refCreates).toBe(created)
        expect(fixture.savedRunRequests.slice(reads)).toEqual([41, 42])
        expect(yield* store.read("old")).toEqual(before)
        fixture.savedRun(42, { run_attempt: 2 })
        expect((yield* Effect.result(leases.revalidateReleased()))._tag).toBe("Failure")
        expect((yield* store.read("old"))?.state).toBe("releasing")
        expect((yield* store.cleanupRuns()).map((row) => row.actions_run_id)).toEqual([41, 42])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

test("custody reconciliation requires an existing SQLite path before any credentials or effects", async () => {
  const child = Bun.spawn(
    [process.execPath, "scripts/evidence/agent-sandbox.mjs", "--reconcile-custody"],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
  )
  expect(await child.exited).toBe(1)
  expect(await new Response(child.stderr).text()).toContain(
    "Existing SQLite custody path is required",
  )
})

test("custody evidence permits discovered runs but rejects changes to saved identities", async () => {
  const source = `
    import assert from "node:assert/strict"
    import { assertCustodyPreserved } from "./scripts/evidence/agent-sandbox.mjs"
    const saved = { repository_id: 1, actions_run_id: 41, actions_attempt: 1, lease_id: "saved", policy: ${JSON.stringify(policy)}, observed_at: 1, state: "pending", last_error: "old" }
    const discovered = { ...saved, actions_run_id: 42, lease_id: "discovered" }
    assertCustodyPreserved([saved], [discovered, { ...saved, state: "released", last_error: null }])
    assert.throws(() => assertCustodyPreserved([saved], [discovered]), /Immutable cleanup custody changed/)
    for (const mutation of [{ lease_id: "foreign" }, { policy: { ...saved.policy, workflowSha: "c".repeat(40) } }, { actions_attempt: 2 }, { observed_at: 2 }])
      assert.throws(() => assertCustodyPreserved([saved], [{ ...saved, ...mutation }]), /Immutable cleanup custody changed/)
  `
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" })
  expect(await new Response(child.stderr).text()).toBe("")
  expect(await child.exited).toBe(0)
})

test("session cleanup uncertainty fences release despite deadline expiry and inventory failure", async () => {
  const { sandboxGithubFixture } = await import("./harness")
  const { makeSandboxGithub } = await import("../../src/sandbox/github")
  const { makeSandboxLeaseService } = await import("../../src/sandbox/lease")
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sandboxMigration
        yield* sandboxCleanupMigration
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "owned",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: 1,
        })
        yield* store.beginStart("owned")
        yield* store.recordRun("owned", 41, 1)
        yield* store.bind("owned", 41, 1, {
          leaseId: "lease-1",
          peerId: "peer",
          address: "127.0.0.1",
          port: 22,
          repositoryPath: "/workspace/repository",
          knownHostsFile: "/tmp/key",
          identityFile: "/dev/null",
        })
        yield* store.attachSession("owned", "ses_owned")
        yield* store.sessionCleanupError("owned")
        fixture.inventoryPages([{ status: 503, total: 0, runs: [] }])
        expect((yield* Effect.result(leases.reconcile([policy])))._tag).toBe("Failure")
        expect((yield* store.read("owned"))?.release_error).toContain("session cleanup")
        fixture.inventoryPages([{ total: 1, runs: [{ id: 41 }] }])
        expect((yield* Effect.result(leases.release("owned")))._tag).toBe("Failure")
        yield* leases.reconcile([policy])
        expect((yield* store.read("owned"))?.state).toBe("operator_required")
        expect((yield* store.read("owned"))?.release_error).toContain("session cleanup")
        expect(fixture.cancellations).toEqual([])
        yield* store.sessionCleanupConfirmed("owned")
        yield* leases.release("owned")
        expect(fixture.cancellations).toEqual([41])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

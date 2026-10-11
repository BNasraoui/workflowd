import { legacySandboxUnit } from "./opencode-fixture"
import { Session } from "@opencode-ai/client/effect"
import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Database } from "bun:sqlite"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import {
  sandboxMigration,
  sandboxCleanupMigration,
  sandboxOperationMigration,
  sandboxCreationMigration,
} from "../../src/sandbox/migration"
import { makeSandboxStore } from "../../src/sandbox/store"
import { sandboxGithubFixture, dispatchRunnerFixture, sandboxCoordinatorProcess } from "./harness"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import { stopSandboxOpenCode } from "../../src/sandbox/opencode"

test("missing run records retain shared session custody instead of releasing its runner", async () => {
  const { sharedOpenCodeFixture } = await import("./opencode-fixture")
  const { makeSandboxDispatch } = await import("../../src/sandbox/dispatch")
  const shared = await sharedOpenCodeFixture("missing-record")
  const fixture = await sandboxGithubFixture(policy)
  const layer = AgentRunStoreLive.pipe(
    Layer.provideMerge(
      WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  )
  try {
    const sessionId = await shared.create(join(shared.root, "owned"), "sandbox")
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        yield* store.request({
          runId: "missing",
          leaseId: "lease-1",
          policy,
          sourceSha: "b".repeat(40),
          now: Date.now(),
        })
        yield* store.beginStart("missing")
        yield* store.recordRun("missing", 41, 1)
        yield* store.attachSession("missing", sessionId)
        const dispatch = yield* makeSandboxDispatch({
          policies: [policy],
          github,
          leases,
          executor: shared.executor,
          client: shared.client,
          executorId: "opencode:opencode-primary",
          endpointIdentity: shared.url,
        })
        yield* dispatch.iteration
        expect((yield* store.read("missing"))?.state).toBe("operator_required")
        expect((yield* store.read("missing"))?.release_error).not.toBeNull()
        expect(fixture.cancellations).toEqual([])
        expect(fixture.refDeletes).toBe(0)
        expect(
          String(
            (yield* shared.client.session.get({ sessionID: Session.ID.make(sessionId) })).agent,
          ),
        ).toBe("sandbox")
      }).pipe(Effect.provide(layer)),
    )
  } finally {
    await fixture.close()
    await shared.close()
  }
})

test("stalled executor cleanup is bounded and revokes its bridge", async () => {
  const { OpenCode } = await import("@opencode-ai/client/effect")
  const { FetchHttpClient } = await import("effect/unstable/http")
  const { TestClock } = await import("effect/testing")
  const { Fiber } = await import("effect")
  const { makeSandboxOpenCode } = await import("../../src/sandbox/opencode")
  const { writeSandboxBinding, readSandboxBinding } = await import("../../src/sandbox/binding")
  const { SdkOpenCodeAdapter, makeOpenCodeSdkClient } = await import("../../src/opencode/adapter")
  const root = await mkdtemp(join(tmpdir(), "sandbox-stalled-cleanup-"))
  const directory = join(root, "location")
  await mkdir(directory)
  const binding = {
    runId: "run",
    leaseId: "lease",
    sessionId: "ses_stalled",
    executorId: "opencode:fixture",
    endpointIdentity: "http://127.0.0.1:1",
    directory,
    locationIdentity: "project",
    bridgeServerName: "wfdlease_lease",
    repositoryId: 1,
    sourceSha: "a".repeat(40),
    policyHash: "b".repeat(64),
    transportHash: "c".repeat(64),
    deadline: Date.now() + 60000,
    state: "active" as const,
  }
  const entered = Promise.withResolvers<void>()
  let aborted = false
  const stalled: typeof fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        entered.resolve()
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new Error("aborted"))
          },
          { once: true },
        )
      }),
    { preconnect: fetch.preconnect },
  )
  try {
    await writeSandboxBinding(binding, true)
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* OpenCode.make({ baseUrl: binding.endpointIdentity }).pipe(
          Effect.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stalled)),
            ),
          ),
        )
        const executor = new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client)))
        const fiber = yield* makeSandboxOpenCode(client, executor)
          .stop(binding)
          .pipe(Effect.result, Effect.forkChild)
        yield* Effect.promise(() => entered.promise)
        yield* TestClock.adjust("31 seconds")
        // Check cancellation before joining so an unbounded request fails instead of hanging.
        expect(aborted).toBe(true)
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure")
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
    expect((await readSandboxBinding(directory)).state).toBe("revoked")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

// These cases start from the same saved primary run; each test controls its failure.
const recoveryLease = (fixture: Awaited<ReturnType<typeof sandboxGithubFixture>>, runId: string) =>
  Effect.gen(function* () {
    yield* sandboxMigration
    yield* sandboxCleanupMigration
    yield* sandboxOperationMigration
    yield* sandboxCreationMigration
    const store = yield* makeSandboxStore
    const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
    const leases = yield* makeSandboxLeaseService(github)
    yield* store.request({
      runId,
      leaseId: "lease-1",
      policy,
      sourceSha: "b".repeat(40),
      now: Date.now(),
    })
    yield* store.beginStart(runId)
    yield* store.recordRun(runId, 41, 1)
    return { store, leases }
  })

test("reconciliation clears only a successful policy's inventory errors despite a foreign failure", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const foreign = { ...policy, repository: "owner/other", repositoryId: 2 }
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { store, leases } = yield* recoveryLease(fixture, "healthy")
        yield* store.bind("healthy", 41, 1, {
          leaseId: "lease-1",
          peerId: "peer",
          address: "127.0.0.1",
          port: 22,
          repositoryPath: "/workspace/repository",
          knownHostsFile: "/tmp/key",
          identityFile: "/dev/null",
        })
        yield* store.adopt(
          foreign,
          { leaseId: "foreign", run: { id: 42, run_attempt: 1 } },
          Date.now(),
        )
        yield* store.inventoryError(policy)
        yield* store.inventoryError(foreign)
        expect((yield* Effect.result(leases.reconcile([foreign, policy])))._tag).toBe("Failure")
        expect((yield* store.read("healthy"))?.release_error).toBeNull()
        const rows = yield* store.cleanupRuns()
        expect(rows.find((row) => row.repository_id === policy.repositoryId)?.last_error).toBeNull()
        expect(
          rows.find((row) => row.repository_id === foreign.repositoryId)?.last_error,
        ).not.toBeNull()
        expect(fixture.cancellations).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

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
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
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
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
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
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
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
        const { store, leases } = yield* recoveryLease(fixture, "active")
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
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
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
        const { store, leases } = yield* recoveryLease(fixture, "active")
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
      yield* sandboxOperationMigration
      yield* sandboxCreationMigration
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
        const { store, leases } = yield* recoveryLease(fixture, "active")
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
        yield* sandboxOperationMigration
        yield* sandboxCreationMigration
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

test.each(["inventory", "DELETE", "acquisition"])(
  "pending GitHub %s leaves shared kernel and other lease operations available",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-fence-"))
    const file = join(root, "custody.sqlite")
    const fixture = await sandboxGithubFixture(policy)
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    let armed = false
    const client = fixture.OctokitClass.defaults({
      request: {
        fetch: async (input: string | Request | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (
            armed &&
            (stage === "inventory"
              ? url.pathname.endsWith("/actions/runs")
              : stage === "DELETE"
                ? init?.method === "DELETE"
                : init?.method === "POST" && url.pathname.endsWith("/git/refs"))
          ) {
            armed = false
            entered.resolve()
            await response.promise
          }
          return fetch(input, init)
        },
      },
    })
    const runtime = ManagedRuntime.make(
      AgentRunStoreLive.pipe(
        Layer.provideMerge(
          WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: file }))),
        ),
      ),
    )
    const other = ManagedRuntime.make(SqliteClient.layer({ filename: file }))
    let releasing: Promise<unknown> | undefined
    try {
      const { store, leases, runs, sql } = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* makeSandboxStore
          const github = yield* makeSandboxGithub(fixture.github, client)
          const leases = yield* makeSandboxLeaseService(github)
          const runs = yield* AgentRunStore
          const sql = yield* SqlClient.SqlClient
          for (const [runId, leaseId] of [
            ["a", "lease-1"],
            ["b", "lease-2"],
          ] as const)
            yield* store.request({
              runId,
              leaseId,
              policy,
              sourceSha: "b".repeat(40),
              now: Date.now(),
            })
          if (stage !== "DELETE") fixture.listRuns([])
          if (stage !== "acquisition") yield* leases.acquire("a")
          yield* store.beginStart("b")
          yield* store.recordRun("b", 77, 1)
          yield* store.bind("b", 77, 1, {
            leaseId: "lease-2",
            peerId: "peer",
            address: "127.0.0.1",
            port: 22,
            repositoryPath: "/workspace/repository",
            knownHostsFile: "/tmp/key",
            identityFile: "/dev/null",
          })
          yield* runs.create({
            runId: "ordinary",
            route: "ordinary",
            providerId: "fixture",
            modelId: "fixture",
            agent: "build",
            repository: "fixture",
            directory: root,
            prompt: "fixture",
            promptSha256: "c".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: new Date(),
          })
          return { store, leases, runs, sql }
        }),
      )
      if (stage === "DELETE") fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
      armed = true
      releasing = runtime.runPromise(
        Effect.result(stage === "acquisition" ? leases.acquire("a") : leases.release("a")),
      )
      await entered.promise
      // These must finish while the HTTP response is still suspended, on the
      // same SQL client the daemon shares with its ordinary agent kernel.
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* runs.claimSpawn({ runId: "ordinary", now: new Date() })
          yield* store.heartbeat("b", 12345)
          expect((yield* store.read("b"))?.heartbeat_at).toBe(12345)
          expect(yield* sql`SELECT run_id FROM kernel_agent_runs`).toEqual([{ run_id: "ordinary" }])
        }).pipe(Effect.timeout("2 seconds")),
      )
      const contender = new Database(file)
      try {
        contender.run("PRAGMA busy_timeout = 30")
        expect(() =>
          contender.run(
            "UPDATE kernel_agent_runs SET diagnostic='independent' WHERE run_id='ordinary'",
          ),
        ).not.toThrow()
      } finally {
        contender.close()
      }
      const deletes = fixture.refDeletes
      const competing = await other.runPromise(
        Effect.gen(function* () {
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          return { leases: yield* makeSandboxLeaseService(github), store: yield* makeSandboxStore }
        }),
      )
      await other.runPromise(competing.leases.release("a").pipe(Effect.timeout("2 seconds")))
      expect(fixture.refDeletes).toBe(deletes)
      fixture.savedRun(42, { status: "in_progress" })
      await other.runPromise(
        competing.store
          .adopt(policy, { leaseId: "lease-1", run: { id: 42, run_attempt: 1 } }, Date.now())
          .pipe(Effect.timeout("2 seconds")),
      )
      response.resolve()
      expect(await releasing).toMatchObject({ _tag: "Success" })
      const saved = await runtime.runPromise(store.cleanupRuns(true))
      expect(saved.find((row) => row.actions_run_id === 42)?.state).toBe("pending")
      expect((await runtime.runPromise(store.read("a")))?.state).toBe("releasing")
      expect((await runtime.runPromise(Effect.result(leases.acquire("a"))))._tag).toBe("Failure")
      fixture.savedRun(42, { status: "completed", conclusion: "cancelled" })
      await runtime.runPromise(leases.release("a"))
      expect((await runtime.runPromise(store.read("a")))?.state).toBe("released")
    } finally {
      response.resolve()
      await releasing
      await other.dispose()
      await runtime.dispose()
      await fixture.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test("a failed direct read retains its run without preventing cancellation of the other saved run", async () => {
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
        const { store, leases } = yield* recoveryLease(fixture, "run-1")
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

for (const fault of [
  "create",
  "add",
  "abort",
  "remove",
  "server",
  "binding",
  "ENOSPC",
  "cancel",
  "queued",
]) {
  test(`shared coordinator retains custody after ${fault} uncertainty and recovers on restart`, async () => {
    const { sharedOpenCodeFixture } = await import("./opencode-fixture")
    const { makeSandboxDispatch } = await import("../../src/sandbox/dispatch")
    const { bindingDirectory, readSandboxBinding, sandboxBridgeName } =
      await import("../../src/sandbox/binding")
    const runner = await dispatchRunnerFixture()
    const githubFixture = await sandboxGithubFixture(policy, runner.name)
    const shared = await sharedOpenCodeFixture("recovery")
    const database = join(runner.root, "shared.sqlite")
    const directory = join(shared.root, "owned")
    const layer = Layer.merge(AgentRunStoreLive, KernelSessionStoreLive).pipe(
      Layer.provideMerge(
        WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: database }))),
      ),
    )
    const controlDirectory = join(shared.root, "ordinary")
    const control = await shared.create(controlDirectory, "build")
    let coordinator: Awaited<ReturnType<typeof sandboxCoordinatorProcess>> | undefined
    let sessionId = ""
    let bridgeName = ""
    let releaseModel: (() => void) | undefined
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeSandboxStore
          const runs = yield* AgentRunStore
          const github = yield* makeSandboxGithub(githubFixture.github, githubFixture.OctokitClass)
          const leases = yield* makeSandboxLeaseService(github, runner.root)
          const service = yield* makeSandboxDispatch({
            policies: [policy],
            github,
            leases,
            executor: shared.executor,
            client: shared.client,
            executorId: "opencode:opencode-primary",
            endpointIdentity: shared.url,
          })
          yield* runs.create({
            runId: "shared",
            route: "sandbox",
            providerId: "openai",
            modelId: "gpt-6-astra-fixture",
            agent: "sandbox",
            repository: policy.alias,
            directory,
            prompt: "Recover this task",
            promptSha256: "b".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: new Date(),
          })
          yield* runs.claimSpawn({ runId: "shared", now: new Date() })
          yield* store.request({
            runId: "shared",
            leaseId: runner.name,
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart("shared")
          yield* store.recordRun("shared", 41, 1)
          yield* store.bind("shared", 41, 1, runner.transport)
          bridgeName = sandboxBridgeName(runner.name)
          if (fault === "create" || fault === "add")
            shared.reject({
              path: fault === "create" ? "/session" : `/mcp/${bridgeName}`,
              method: fault === "create" ? "POST" : "PUT",
              status: 502,
              after: true,
            })
          const run = (yield* runs.read("shared"))!
          const launched = yield* Effect.result(
            service.launch(run, { providerID: "openai", modelID: "gpt-6-astra-fixture" }),
          )
          shared.reject()
          expect(launched._tag).toBe(fault === "create" || fault === "add" ? "Failure" : "Success")
          sessionId = (yield* store.read("shared"))?.session_id ?? ""
          expect(sessionId).not.toBe("")
          if (launched._tag === "Success") {
            const sessions = yield* KernelSessionStore
            yield* sessions.registerResource({
              resourceId: "shared-resource",
              owningHostId: "mint",
              absolutePath: directory,
              kind: "workspace",
              createdAt: new Date(),
            })
            yield* sessions.registerSession({
              sessionId: "shared-session",
              nativeSessionId: sessionId,
              resourceId: "shared-resource",
              providerKind: "opencode",
              providerVersion: 1,
              providerId: "opencode-primary",
              serverId: "opencode-primary",
              endpointAlias: "local",
              endpointIdentity: shared.url,
              owningHostId: "mint",
              createdAt: new Date(),
            })
            yield* runs.markSpawned({
              runId: "shared",
              sessionId: "shared-session",
              nativeSessionId: sessionId,
              resourceId: "shared-resource",
              now: new Date(),
            })
            yield* runs.markVerified({ runId: "shared", outputTokens: 1, now: new Date() })
          }
        }).pipe(Effect.provide(layer)),
      )
      const bindingFile = join(bindingDirectory(directory), "binding.json")
      const savedBinding = await Bun.file(bindingFile).text()
      if (fault === "binding") await rm(bindingFile)
      if (fault === "queued") {
        releaseModel = shared.holdModel()
        await shared.api(`session/${sessionId}/prompt`, { text: "Active sandbox turn" })
        const { Schedule } = await import("effect")
        const active = await Effect.runPromise(
          shared.client.session.active().pipe(
            Effect.repeat({
              until: (active) => active[Session.ID.make(sessionId)] !== undefined,
              schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ times: 100 })),
            }),
          ),
        )
        expect(active[Session.ID.make(sessionId)]).toBeDefined()
        await shared.api(`session/${sessionId}/prompt`, {
          text: "Queued sandbox turn",
          resume: false,
        })
        await shared.api(`session/${control}/prompt`, {
          text: "Queued ordinary turn",
          resume: false,
        })
      }
      const input = {
        database,
        policy,
        github: githubFixture.github,
        apiUrl: githubFixture.apiUrl,
        openCodeUrl: shared.url,
      }
      const localFault =
        fault === "abort"
          ? { path: "/interrupt", method: "POST", after: true }
          : fault === "remove"
            ? { path: `/mcp/${bridgeName}`, method: "DELETE", after: true }
            : fault === "server"
              ? { path: "" }
              : undefined
      if (fault === "cancel") githubFixture.failCancellation(502)
      coordinator = await sandboxCoordinatorProcess({
        ...input,
        ...(localFault ? { openCodeFault: localFault } : {}),
        ...(fault === "ENOSPC"
          ? {
              fullControlDirectory: bindingDirectory(directory),
              fullControlFiles: { "binding.json": savedBinding },
            }
          : {}),
      })
      await coordinator.stop()
      coordinator = undefined
      releaseModel?.()
      if (["abort", "remove", "server", "binding", "ENOSPC"].includes(fault)) {
        expect(githubFixture.cancellations).toEqual([])
        expect(githubFixture.refDeletes).toBe(0)
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* makeSandboxStore
            expect((yield* store.read("shared"))?.state).toBe("operator_required")
            expect((yield* store.read("shared"))?.release_error).not.toBeNull()
            const runs = yield* AgentRunStore
            expect((yield* runs.read("shared"))?.state).toBe("verified")
          }).pipe(Effect.provide(layer)),
        )
      }
      if (fault === "binding") await Bun.write(bindingFile, savedBinding)
      if (fault === "server") await shared.restart()
      githubFixture.failCancellation(202)
      githubFixture.listRuns([])
      githubFixture.mutateRun({ status: "completed", conclusion: "cancelled" })
      coordinator = await sandboxCoordinatorProcess(input)
      await coordinator.stop()
      coordinator = undefined
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeSandboxStore
          const runs = yield* AgentRunStore
          expect((yield* store.read("shared"))?.state).toBe("released")
          expect((yield* runs.read("shared"))?.state).toBe("operator_required")
        }).pipe(Effect.provide(layer)),
      )
      expect((await readSandboxBinding(directory)).state).toBe("revoked")
      expect(
        String(
          (
            await Effect.runPromise(
              shared.client.session.get({ sessionID: Session.ID.make(sessionId) }),
            )
          ).agent,
        ),
      ).toBe("sandbox")
      const catalog = await shared.api(
        `mcp?${new URLSearchParams({ "location[directory]": directory }).toString()}`,
      )
      expect(JSON.stringify(catalog)).not.toContain(bridgeName)
      if (fault === "queued") {
        expect(
          await Effect.runPromise(
            shared.client.session.inbox.list({ sessionID: Session.ID.make(sessionId) }),
          ),
        ).toEqual([])
        expect(
          await Effect.runPromise(
            shared.client.session.inbox.list({ sessionID: Session.ID.make(control) }),
          ),
        ).toHaveLength(1)
      }
      shared.script([
        {
          name: "shell",
          arguments: JSON.stringify({
            command: "printf survived > control",
            description: "Ordinary session survives sandbox recovery",
          }),
        },
      ])
      await shared.prompt(control, "Run the ordinary control")
      expect(await Bun.file(join(controlDirectory, "control")).text()).toBe("survived")
    } finally {
      releaseModel?.()
      await coordinator?.stop()
      await githubFixture.close()
      await shared.close()
      await runner.close()
    }
  }, 120000)
}

test("revocation survives a delayed active binding write and denies bridge reconnection", async () => {
  const {
    bindingDirectory,
    writeSandboxBinding,
    readSandboxBinding,
    assertBridgeBinding,
    transportHash,
  } = await import("../../src/sandbox/binding")
  const root = await mkdtemp(join(tmpdir(), "sandbox-tombstone-"))
  const directory = join(root, "location")
  await mkdir(directory)
  const transport = {
    leaseId: "lease",
    peerId: "peer",
    address: "127.0.0.1",
    port: 22,
    repositoryPath: "/workspace/repository" as const,
    identityFile: "/dev/null",
    knownHostsFile: "/tmp/hosts",
  }
  const active = {
    runId: "run",
    leaseId: "lease",
    sessionId: "ses_test",
    executorId: "opencode:fixture",
    endpointIdentity: "http://127.0.0.1:1",
    directory,
    locationIdentity: "project",
    bridgeServerName: "wfdlease_lease",
    repositoryId: 1,
    sourceSha: "a".repeat(40),
    policyHash: "b".repeat(64),
    transportHash: transportHash(transport),
    deadline: Date.now() + 60000,
    state: "active" as const,
  }
  try {
    await writeSandboxBinding(active, true)
    await writeSandboxBinding({ ...active, state: "revoked" })
    const file = join(bindingDirectory(directory), "binding.json")
    // An in-flight writer read active custody before revocation and renamed late.
    await Bun.write(file, JSON.stringify(active))
    expect((await readSandboxBinding(directory)).state).toBe("revoked")
    await expect(assertBridgeBinding(file, transport)).rejects.toThrow("revoked")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("revoking a binding terminates an in-flight SSH tool call before its response", async () => {
  const { runnerFixture, bridgeClient } = await import("./harness")
  const { bindingDirectory, writeSandboxBinding, transportHash } =
    await import("../../src/sandbox/binding")
  const runner = await runnerFixture()
  const directory = join(runner.root, "location")
  await mkdir(directory)
  const active = {
    runId: "run",
    leaseId: runner.transport.leaseId,
    sessionId: "ses_test",
    executorId: "opencode:fixture",
    endpointIdentity: "http://127.0.0.1:1",
    directory,
    locationIdentity: "project",
    bridgeServerName: "wfdlease_lease",
    repositoryId: 1,
    sourceSha: "a".repeat(40),
    policyHash: "b".repeat(64),
    transportHash: transportHash(runner.transport),
    deadline: Date.now() + 120000,
    state: "active" as const,
  }
  let bridge: ReturnType<typeof bridgeClient> | undefined
  try {
    const wrapper = join(runner.root, "observed-container-use")
    await Bun.write(
      wrapper,
      '#!/bin/sh\ncd /workspace/repository\ntee /tmp/bridge-requests | env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/runner _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://engine:1234 /usr/local/bin/container-use-real "$@"\n',
    )
    await runner.docker("cp", wrapper, `${runner.name}-runner:/usr/local/bin/container-use`)
    await runner.docker(
      "exec",
      "-u",
      "root",
      `${runner.name}-runner`,
      "chmod",
      "755",
      "/usr/local/bin/container-use",
    )
    await writeSandboxBinding(active, true)
    bridge = bridgeClient(runner.transport, join(bindingDirectory(directory), "binding.json"))
    await bridge.initialize()
    await bridge.request("tools/list")
    const created = await bridge.request("tools/call", {
      name: "environment_create",
      arguments: { environment_source: "/workspace/repository", title: "Revocation" },
    })
    const { Schema, Schedule } = await import("effect")
    const content = Schema.decodeUnknownSync(
      Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
    )(created)
    const environment = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      JSON.parse(content.content[0]!.text),
    )
    const pending = bridge
      .request("tools/call", {
        name: "environment_run_cmd",
        arguments: {
          environment_source: "/workspace/repository",
          environment_id: environment.id,
          command: "sleep 20; printf revocation-inflight",
        },
      })
      .then(
        () => "completed",
        () => "refused",
      )
    const observed = await Effect.runPromise(
      Effect.tryPromise(() =>
        runner.docker("exec", `${runner.name}-runner`, "cat", "/tmp/bridge-requests"),
      ).pipe(
        Effect.repeat({
          until: (text) => text.includes("revocation-inflight"),
          schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ times: 100 })),
        }),
      ),
    )
    expect(observed).toContain("revocation-inflight")
    await writeSandboxBinding({ ...active, state: "revoked" })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 2000)
      })
      expect(await Promise.race([pending, deadline])).toBe("refused")
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await bridge?.close()
    await runner.close()
  }
}, 60000)

test.each(["cleanup", "acquisition"])(
  "expired %s owner cannot commit or clear its replacement after restart",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-operation-"))
    const file = join(root, "custody.sqlite")
    const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: file }))
    const restarted = ManagedRuntime.make(SqliteClient.layer({ filename: file }))
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const
    const responses = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const
    const pending: Promise<unknown>[] = []
    try {
      const { store, row } = await runtime.runPromise(
        Effect.gen(function* () {
          yield* sandboxMigration
          yield* sandboxCleanupMigration
          yield* sandboxOperationMigration
          yield* sandboxCreationMigration
          const store = yield* makeSandboxStore
          yield* store.request({
            runId: "run",
            leaseId: "lease-1",
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart("run")
          yield* store.recordRun("run", 41, 1)
          const [row] = yield* store.cleanupRuns()
          if (!row) throw new Error("missing custody")
          if (kind === "cleanup") {
            yield* store.beginRelease("run")
            yield* store.cleanupState(row, "terminated")
          }
          return { store, row }
        }),
      )
      const { store: other, sql: otherSql } = await restarted.runPromise(
        Effect.gen(function* () {
          return { store: yield* makeSandboxStore, sql: yield* SqlClient.SqlClient }
        }),
      )
      const operation = (target: typeof store, index: 0 | 1) => {
        const io = Effect.promise(() => {
          entered[index].resolve()
          return responses[index].promise
        })
        return kind === "cleanup"
          ? target.finishCleanup(row, io, Effect.void)
          : target.withAcquisition(
              "run",
              () => Effect.void,
              (commit) => io.pipe(Effect.andThen(commit(target.recordRun("run", 41, 1)))),
            )
      }
      pending.push(runtime.runPromise(Effect.result(operation(store, 0))))
      await entered[0].promise
      // Simulate a persisted owner whose process died and recovery horizon elapsed.
      await restarted.runPromise(otherSql`UPDATE sandbox_lease_operations SET expires_at=0`)
      pending.push(restarted.runPromise(Effect.result(operation(other, 1))))
      await entered[1].promise
      const replacement = await restarted.runPromise(
        otherSql`SELECT * FROM sandbox_lease_operations`,
      )
      responses[0].resolve()
      expect(await pending[0]).toMatchObject({ _tag: kind === "cleanup" ? "Success" : "Failure" })
      expect(await restarted.runPromise(otherSql`SELECT * FROM sandbox_lease_operations`)).toEqual(
        replacement,
      )
      expect((await restarted.runPromise(other.read("run")))?.state).toBe(
        kind === "cleanup" ? "releasing" : "starting",
      )
      responses[1].resolve()
      expect(await pending[1]).toMatchObject({ _tag: "Success" })
      expect(
        await restarted.runPromise(otherSql`SELECT owner,expires_at FROM sandbox_lease_operations`),
      ).toEqual([{ owner: null, expires_at: null }])
      expect((await restarted.runPromise(other.read("run")))?.state).toBe(
        kind === "cleanup" ? "released" : "starting",
      )
    } finally {
      for (const response of responses) response.resolve()
      await Promise.all(pending)
      await restarted.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.each(["interruption", "timeout"])(
  "a delayed ref POST retains custody after %s, including recovery after owner expiry",
  async (stop) => {
    const { Fiber } = await import("effect")
    const { TestClock } = await import("effect/testing")
    const root = await mkdtemp(join(tmpdir(), "sandbox-delayed-post-"))
    const fixture = await sandboxGithubFixture(policy)
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    const delivered = Promise.withResolvers<void>()
    let signal: AbortSignal | null | undefined
    let armed = true
    const client = fixture.OctokitClass.defaults({
      request: {
        fetch: async (input: string | Request | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (armed && init?.method === "POST" && url.pathname.endsWith("/git/refs")) {
            armed = false
            signal = init.signal
            entered.resolve()
            await response.promise
            // A server can finish accepted work after its client disconnects.
            const result = await fetch(input, { ...init, signal: null })
            delivered.resolve()
            return result
          }
          return fetch(input, init)
        },
      },
    })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* sandboxMigration
          yield* sandboxCleanupMigration
          yield* sandboxOperationMigration
          yield* sandboxCreationMigration
          const store = yield* makeSandboxStore
          const sql = yield* SqlClient.SqlClient
          const github = yield* makeSandboxGithub(fixture.github, client)
          const leases = yield* makeSandboxLeaseService(github)
          yield* store.request({
            runId: "run",
            leaseId: "lease-1",
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now(),
          })
          const first = yield* Effect.forkChild(Effect.result(leases.acquire("run")))
          yield* Effect.promise(() => entered.promise)
          if (stop === "timeout") {
            yield* TestClock.adjust("9 minutes")
            expect((yield* Fiber.join(first))._tag).toBe("Failure")
          } else yield* Fiber.interrupt(first)
          fixture.mutateRun({ status: "completed", conclusion: "cancelled" })
          yield* leases.acquire("run")
          if (stop === "timeout") yield* leases.release("run")
          expect((yield* store.read("run"))?.state).not.toBe("released")
          expect(fixture.refCreates).toBe(0)
          expect(signal?.aborted).toBe(true)
          expect((yield* sql`SELECT owner FROM sandbox_lease_operations`)[0]?.owner).not.toBeNull()
          // A new SQL client models restart. Expiry alone must not prove that
          // the old remote POST stopped, nor authorize a second POST or deletion.
          const recover = Effect.gen(function* () {
            const otherSql = yield* SqlClient.SqlClient
            yield* otherSql`UPDATE sandbox_lease_operations SET expires_at=0`
            const otherGithub = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
            const other = yield* makeSandboxLeaseService(otherGithub)
            yield* Effect.result(stop === "timeout" ? other.release("run") : other.acquire("run"))
          }).pipe(Effect.provide(SqliteClient.layer({ filename: join(root, "custody.sqlite") })))
          yield* recover
          expect((yield* store.read("run"))?.state).not.toBe("released")
          expect(fixture.refDeletes).toBe(0)
          response.resolve()
          yield* Effect.promise(() => delivered.promise)
          expect(fixture.refCreates).toBe(1)
          yield* recover
          expect((yield* store.read("run"))?.state).toBe("released")
          expect(fixture.refCreates).toBe(1)
          expect(yield* sql`SELECT owner,expires_at FROM sandbox_lease_operations`).toEqual([
            { owner: null, expires_at: null },
          ])
          const exact = yield* Effect.promise(() =>
            fetch(
              fixture.apiUrl + `repos/${policy.repository}/git/ref/heads/workflowd/leases/lease-1`,
              { headers: { Authorization: "Bearer fixture-token" } },
            ),
          )
          expect(exact.status).toBe(404)
        }).pipe(
          Effect.provide(SqliteClient.layer({ filename: join(root, "custody.sqlite") })),
          Effect.provide(TestClock.layer()),
        ),
      )
    } finally {
      response.resolve()
      await delivered.promise
      await fixture.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test("interrupted ref cleanup retains its operation owner and custody for recovery", async () => {
  const { Fiber } = await import("effect")
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* sandboxMigration
      yield* sandboxCleanupMigration
      yield* sandboxOperationMigration
      yield* sandboxCreationMigration
      const store = yield* makeSandboxStore
      const sql = yield* SqlClient.SqlClient
      yield* store.adopt(policy, { leaseId: "orphan", run: { id: 41, run_attempt: 1 } }, Date.now())
      const [row] = yield* store.cleanupRuns()
      if (!row) throw new Error("missing custody")
      yield* store.cleanupState(row, "terminated")
      const entered = Promise.withResolvers<void>()
      const fiber = yield* store
        .finishCleanup(
          row,
          Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never)),
          Effect.void,
        )
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => entered.promise)
      yield* Fiber.interrupt(fiber)
      expect((yield* sql`SELECT owner FROM sandbox_lease_operations`)[0]?.owner).not.toBeNull()
      expect((yield* store.cleanupRuns())[0]?.state).toBe("terminated")
      yield* sql`UPDATE sandbox_lease_operations SET expires_at=0`
      yield* store.finishCleanup(row, Effect.void, Effect.void)
      expect(yield* store.cleanupRuns()).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
})

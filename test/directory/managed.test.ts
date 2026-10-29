import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DirectoryStore, DirectoryStoreLive } from "../../src/directory/store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import { makeResidentStore } from "../../src/resident/store"
import { runAgentRunWatchdogIteration } from "../../src/kernel/agent-run-watchdog"
import { AgentRunProvider } from "../../src/kernel/agent-run-ingress"
import { OpenCodeAdapterError } from "../../src/opencode/adapter"
import { WorkSignal } from "../../src/work-signal"

const at = new Date("2026-10-01T12:00:00.000Z")
const layer = Layer.mergeAll(DirectoryStoreLive, AgentRunStoreLive, KernelSessionStoreLive).pipe(
  Layer.provideMerge(
    WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  ),
)
test("managed directory waits for verification, expires observations and preserves logical identity across native rebind", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* DirectoryStore
      const runs = yield* AgentRunStore
      const sessions = yield* KernelSessionStore
      const sql = yield* SqlClient.SqlClient
      yield* directory.bindLocalHost("host-a")
      const input = {
        runId: "agent-run-managed",
        route: "fixture",
        executorKind: "opencode" as const,
        providerId: "p",
        modelId: "m",
        agent: "fixture",
        repository: "fixture",
        directory: "/tmp/owned",
        prompt: "inert",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 2,
        createdAt: at,
      }
      yield* runs.create(input)
      yield* runs.claimSpawn({ runId: input.runId, now: at })
      expect((yield* directory.managed(at, 1000))[0]).toMatchObject({
        status: "launching",
        endpoint: null,
        deliverable: false,
      })
      yield* sessions.registerResource({
        resourceId: "owned",
        owningHostId: "host-a",
        absolutePath: "/tmp/owned",
        kind: "worktree",
        createdAt: at,
      })
      const session = (nativeSessionId: string) =>
        sessions.registerSession({
          sessionId: `opencode-session-${nativeSessionId}`,
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "server",
          serverId: "server",
          owningHostId: "host-a",
          endpointAlias: "local",
          endpointIdentity: "http://127.0.0.1:4096",
          nativeSessionId,
          resourceId: "owned",
          createdAt: at,
        })
      yield* session("one")
      yield* runs.markSpawned({
        runId: input.runId,
        resourceId: "owned",
        sessionId: "opencode-session-one",
        nativeSessionId: "one",
        now: at,
      })
      expect((yield* directory.managed(at, 1000))[0]).toMatchObject({
        status: "launching",
        endpoint: null,
        deliverable: false,
      })
      yield* runs.markVerified({ runId: input.runId, outputTokens: 1, now: at })
      expect((yield* directory.managed(at, 1000))[0]?.deliverable).toBe(false)
      yield* directory.observeManaged(
        input.runId,
        { nativeSessionId: "one", directory: "/tmp/owned" },
        at,
        1000,
      )
      const first = (yield* directory.managed(at, 1000))[0]!
      expect(first).toMatchObject({
        status: "active",
        deliverable: true,
        endpoint: { nativeSessionId: "one" },
      })
      yield* sql`UPDATE kernel_sessions SET provider_kind = 'codex' WHERE session_id = 'opencode-session-one'`
      expect((yield* directory.managed(at, 1000))[0]).toMatchObject({
        status: "unavailable",
        deliverable: false,
        endpoint: null,
      })
      yield* sql`UPDATE kernel_sessions SET provider_kind = 'opencode' WHERE session_id = 'opencode-session-one'`
      expect((yield* directory.managed(new Date(at.getTime() + 1000), 1000))[0]).toMatchObject({
        status: "expired",
        deliverable: false,
      })
      yield* sql`UPDATE kernel_agent_runs SET native_session_id = 'unverified-label' WHERE run_id = ${input.runId}`
      expect((yield* directory.managed(at, 1000))[0]).toMatchObject({
        status: "unavailable",
        endpoint: null,
        deliverable: false,
      })
      yield* sql`UPDATE kernel_agent_runs SET native_session_id = 'one' WHERE run_id = ${input.runId}`
      yield* session("two")
      // Simulate the authoritative custody owner replacing a native binding, never public registration.
      yield* sql`UPDATE kernel_agent_runs SET session_id = 'opencode-session-two', native_session_id = 'two' WHERE run_id = ${input.runId}`
      expect((yield* directory.managed(at, 1000))[0]?.deliverable).toBe(false)
      yield* runs.markVerified({ runId: input.runId, outputTokens: 2, now: at })
      expect((yield* directory.managed(at, 1000))[0]?.deliverable).toBe(false)
      yield* directory.observeManaged(
        input.runId,
        { nativeSessionId: "two", directory: "/tmp/owned" },
        at,
        1000,
      )
      const rebound = (yield* directory.managed(at, 1000))[0]!
      expect(rebound.recipientId).toBe(first.recipientId)
      expect(rebound.bindingVersion).toBeGreaterThan(first.bindingVersion)
      expect(rebound.endpoint?.nativeSessionId).toBe("two")
      const touchedAt = new Date(at.getTime() + 5000)
      yield* runs.touch({ runId: input.runId, now: touchedAt })
      expect((yield* directory.managed(touchedAt, 1000))[0]).toMatchObject({
        status: "expired",
        deliverable: false,
        observedAt: at.toISOString(),
      })
      const observedAt = new Date(touchedAt.getTime() + 1000)
      const observe = (reachable: boolean, now: Date) =>
        runAgentRunWatchdogIteration({
          progressWindowMs: 60_000,
          staleAfterMs: 1,
          directoryLeaseMs: 1000,
          unsupervisedExecutorKinds: [],
          now: () => now,
        }).pipe(
          Effect.provide(
            Layer.mock(AgentRunProvider, {
              sessionTelemetry: () =>
                reachable
                  ? Effect.succeed({
                      sessionID: "two",
                      directory: "/tmp/owned",
                      outputTokens: 2,
                      idle: false,
                      updatedAtMs: now.getTime(),
                    })
                  : Effect.fail(
                      new OpenCodeAdapterError({
                        operation: "fixture telemetry",
                        cause: new Error("unreachable"),
                      }),
                    ),
            }),
          ),
          Effect.provide(Layer.mock(WorkSignal, { wake: () => Effect.void })),
        )
      yield* observe(true, observedAt)
      expect((yield* directory.managed(observedAt, 1000))[0]).toMatchObject({
        status: "active",
        deliverable: true,
        observedAt: observedAt.toISOString(),
      })
      const unreachableAt = new Date(observedAt.getTime() + 500)
      yield* observe(false, unreachableAt)
      expect((yield* directory.managed(unreachableAt, 1000))[0]).toMatchObject({
        status: "unavailable",
        deliverable: false,
        observedAt: observedAt.toISOString(),
      })
      yield* runs.beginAttempt({
        runId: input.runId,
        attempt: 2,
        diagnostic: "administrative retry bookkeeping",
        now: new Date(unreachableAt.getTime() + 100),
      })
      expect((yield* directory.managed(unreachableAt, 1000))[0]).toMatchObject({
        status: "unavailable",
        deliverable: false,
        observedAt: observedAt.toISOString(),
      })
      yield* runs.operatorRequired({ runId: input.runId, diagnostic: "stop uncertain", now: at })
      expect((yield* directory.managed(at, 1000))[0]).toMatchObject({
        status: "unavailable",
        deliverable: false,
      })
      const collision = yield* directory.bindLocalHost("host-b").pipe(Effect.result)
      expect(collision).toMatchObject({
        _tag: "Failure",
        failure: { reason: "ownership_conflict" },
      })
    }).pipe(Effect.provide(layer)),
  )
})

test("historical run backfill requires a current native observation despite recent retry bookkeeping", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* DirectoryStore
      const runs = yield* AgentRunStore
      const sessions = yield* KernelSessionStore
      const runId = "agent-run-before-directory"
      yield* runs.create({
        runId,
        route: "fixture",
        executorKind: "opencode",
        providerId: "p",
        modelId: "m",
        agent: "fixture",
        repository: "fixture",
        directory: "/tmp/owned",
        prompt: "inert",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 2,
        createdAt: at,
      })
      yield* runs.claimSpawn({ runId, now: at })
      yield* sessions.registerResource({
        resourceId: "owned",
        owningHostId: "host-a",
        absolutePath: "/tmp/owned",
        kind: "worktree",
        createdAt: at,
      })
      yield* sessions.registerSession({
        sessionId: "opencode-session-one",
        nativeSessionId: "one",
        providerKind: "opencode",
        providerVersion: 1,
        providerId: "server",
        serverId: "server",
        owningHostId: "host-a",
        endpointAlias: "local",
        endpointIdentity: "http://127.0.0.1:4096",
        resourceId: "owned",
        createdAt: at,
      })
      yield* runs.markSpawned({
        runId,
        resourceId: "owned",
        sessionId: "opencode-session-one",
        nativeSessionId: "one",
        now: at,
      })
      yield* runs.markVerified({ runId, outputTokens: 1, now: at })
      const now = new Date(at.getTime() + 5000)
      yield* runs.beginAttempt({ runId, attempt: 2, diagnostic: "retry", now })
      yield* directory.bindLocalHost("host-a")
      expect((yield* directory.managed(now, 1000))[0]).toMatchObject({
        recipientId: `managed:host-a:${runId}`,
        status: "unavailable",
        deliverable: false,
        endpoint: null,
      })
      yield* directory.observeManaged(
        runId,
        { nativeSessionId: "one", directory: "/tmp/owned" },
        now,
        1000,
      )
      expect((yield* directory.managed(now, 1000))[0]).toMatchObject({
        recipientId: `managed:host-a:${runId}`,
        status: "active",
        deliverable: true,
        observedAt: now.toISOString(),
      })
      expect(yield* runs.read(runId)).toMatchObject({ state: "verified", attempt: 2 })
    }).pipe(Effect.provide(layer)),
  )
})

test("resident reacquisition invalidates old native proof until its custody owner observes the endpoint again", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* DirectoryStore
      const runs = yield* AgentRunStore
      const sessions = yield* KernelSessionStore
      const resident = yield* makeResidentStore
      yield* directory.bindLocalHost("host-a")
      yield* runs.create({
        runId: "resident",
        route: "fixture",
        executorKind: "codex",
        providerId: "native",
        modelId: "same-model",
        agent: "worker",
        repository: "fixture",
        directory: "/tmp/resident",
        prompt: "inert",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 1,
        createdAt: at,
      })
      yield* runs.claimSpawn({ runId: "resident", now: at })
      yield* sessions.registerResource({
        resourceId: "resident",
        owningHostId: "host-a",
        absolutePath: "/tmp/resident",
        kind: "worktree",
        createdAt: at,
      })
      yield* sessions.registerSession({
        sessionId: "resident",
        nativeSessionId: "thread",
        providerKind: "codex",
        providerVersion: 1,
        providerId: "native",
        serverId: "local",
        owningHostId: "host-a",
        endpointAlias: "local",
        endpointIdentity: "codex-cli://host-a",
        resourceId: "resident",
        createdAt: at,
      })
      yield* resident.attach("resident", "thread", "/tmp/resident", "same-model")
      yield* runs.markSpawned({
        runId: "resident",
        resourceId: "resident",
        sessionId: "resident",
        nativeSessionId: "thread",
        now: at,
      })
      yield* runs.markVerified({ runId: "resident", outputTokens: 1, now: at })
      yield* directory.observeManaged(
        "resident",
        { nativeSessionId: "thread", directory: "/tmp/resident" },
        at,
        1000,
      )
      const first = (yield* directory.managed(at, 1000))[0]!
      expect(first.deliverable).toBe(true)
      yield* resident.recordClosure("thread", false)
      expect((yield* directory.managed(at, 1000))[0]).toMatchObject({
        status: "unavailable",
        deliverable: false,
        endpoint: null,
      })
      yield* directory.observeManaged(
        "resident",
        { nativeSessionId: "wrong-session", directory: "/tmp/resident" },
        at,
        1000,
      )
      expect((yield* directory.managed(at, 1000))[0]?.deliverable).toBe(false)
      const later = new Date(at.getTime() + 1500)
      yield* directory.observeManaged(
        "resident",
        { nativeSessionId: "thread", directory: "/tmp/resident" },
        later,
        1000,
      )
      expect((yield* directory.managed(later, 1000))[0]).toMatchObject({
        recipientId: first.recipientId,
        deliverable: true,
        observedAt: later.toISOString(),
      })
      yield* resident.recordClosure("thread", true)
      yield* directory.observeManaged(
        "resident",
        { nativeSessionId: "thread", directory: "/tmp/resident" },
        later,
        1000,
      )
      expect((yield* directory.managed(later, 1000))[0]?.deliverable).toBe(false)
    }).pipe(Effect.provide(layer)),
  )
})

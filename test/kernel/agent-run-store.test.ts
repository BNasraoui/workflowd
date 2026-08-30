import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import {
  AgentRunStore,
  AgentRunStoreConflictError,
  type AgentRunCreateInput,
  AgentRunStoreLive,
} from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"

const at = new Date("2026-08-30T09:00:00.000Z")
const later = new Date("2026-08-30T09:05:00.000Z")

const layer = Layer.merge(AgentRunStoreLive, KernelSessionStoreLive).pipe(
  Layer.provideMerge(
    WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  ),
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const input: AgentRunCreateInput = {
  runId: "agent-run-abc",
  route: "implement",
  providerId: "zai-coding-plan",
  modelId: "glm-5.3-flash",
  agent: "remote-worker",
  repository: "workflowd",
  directory: "/tmp/worktrees/agent-runs/abc",
  prompt: "Fix the flaky test",
  promptSha256: "a".repeat(64),
  parentSessionId: null,
  resumePrompt: null,
  maxAttempts: 3,
  createdAt: at,
}

const spawn = (store: typeof AgentRunStore.Service) =>
  Effect.gen(function* () {
    const sessions = yield* KernelSessionStore
    yield* sessions.registerResource({
      resourceId: "resource-1",
      owningHostId: "mint",
      absolutePath: "/tmp/worktrees/agent-runs/abc",
      kind: "worktree",
      createdAt: at,
    })
    yield* sessions.registerSession({
      sessionId: "opencode-session-ses_1",
      providerKind: "opencode",
      providerVersion: 1,
      providerId: "opencode-primary",
      serverId: "opencode-primary",
      owningHostId: "mint",
      endpointAlias: "local",
      endpointIdentity: "http://127.0.0.1:4096",
      nativeSessionId: "ses_1",
      resourceId: "resource-1",
      createdAt: at,
    })
    yield* store.markSpawned({
      runId: input.runId,
      resourceId: "resource-1",
      sessionId: "opencode-session-ses_1",
      nativeSessionId: "ses_1",
      now: at,
    })
  })

describe("agent-run store", () => {
  test("create is exact-match idempotent and conflicts on divergent identity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* AgentRunStore
        const first = yield* store.create(input)
        const replay = yield* store.create(input)
        const conflict = yield* store
          .create({ ...input, prompt: "different prompt" })
          .pipe(Effect.result)
        return { first, replay, conflict }
      }),
    )
    expect(result.first.status).toBe("created")
    expect(result.replay.status).toBe("duplicate")
    expect(result.conflict._tag).toBe("Failure")
    if (result.conflict._tag === "Failure") {
      expect(result.conflict.failure).toBeInstanceOf(AgentRunStoreConflictError)
    }
  })

  test("walks the state machine and refuses transitions from the wrong state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* AgentRunStore
        yield* store.create(input)
        // verifying before spawning is a conflict
        const early = yield* store
          .markVerified({ runId: input.runId, outputTokens: 5, now: at })
          .pipe(Effect.result)
        yield* spawn(store)
        yield* store.markVerified({ runId: input.runId, outputTokens: 5, now: at })
        yield* store.recordProgress({ runId: input.runId, outputTokens: 9, now: later })
        yield* store.beginAttempt({
          runId: input.runId,
          attempt: 2,
          diagnostic: "resumed_after_interrupted",
          now: later,
        })
        const skipped = yield* store
          .beginAttempt({ runId: input.runId, attempt: 4, diagnostic: "x", now: later })
          .pipe(Effect.result)
        yield* store.complete({ runId: input.runId, now: later })
        const record = yield* store.read(input.runId)
        return { early, skipped, record }
      }),
    )
    expect(result.early._tag).toBe("Failure")
    expect(result.skipped._tag).toBe("Failure")
    expect(result.record?.state).toBe("completed")
    expect(result.record?.attempt).toBe(2)
    expect(result.record?.lastOutputTokens).toBe(9)
  })

  test("beginAttempt refuses to exceed max_attempts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* AgentRunStore
        yield* store.create({ ...input, maxAttempts: 2 })
        yield* spawn(store)
        yield* store.markVerified({ runId: input.runId, outputTokens: 1, now: at })
        yield* store.beginAttempt({ runId: input.runId, attempt: 2, diagnostic: "1", now: at })
        return yield* store
          .beginAttempt({ runId: input.runId, attempt: 3, diagnostic: "2", now: at })
          .pipe(Effect.result)
      }),
    )
    expect(result._tag).toBe("Failure")
  })

  test("nextWatchable returns verified runs and only stale pre-verification runs", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* AgentRunStore
        yield* store.create(input)
        // A fresh accepted run is not watchable: its dispatching request owns it.
        const fresh = yield* store.nextWatchable({ now: at, staleAfterMs: 60_000 })
        const stale = yield* store.nextWatchable({
          now: new Date(at.getTime() + 120_000),
          staleAfterMs: 60_000,
        })
        yield* spawn(store)
        yield* store.markVerified({ runId: input.runId, outputTokens: 1, now: at })
        const verified = yield* store.nextWatchable({ now: at, staleAfterMs: 60_000 })
        yield* store.operatorRequired({ runId: input.runId, diagnostic: "done", now: at })
        const terminal = yield* store.nextWatchable({ now: at, staleAfterMs: 60_000 })
        return { fresh, stale, verified, terminal }
      }),
    )
    expect(result.fresh).toBeNull()
    expect(result.stale?.runId).toBe(input.runId)
    expect(result.verified?.state).toBe("verified")
    expect(result.terminal).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { AgentRunProvider, type AgentRunProviderPort } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { runAgentRunWatchdogIteration } from "../../src/kernel/agent-run-watchdog"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import type { OpenCodeSessionTelemetry } from "../../src/opencode/adapter"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal, type WorkSignalPort } from "../../src/work-signal"

const at = new Date("2026-08-30T11:00:00.000Z")
const minutes = (count: number) => new Date(at.getTime() + count * 60_000)

const storesLayer = Layer.merge(AgentRunStoreLive, KernelSessionStoreLive).pipe(
  Layer.provideMerge(
    WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  ),
)

type ProviderCalls = {
  prompted: Array<{ sessionID: string; text: string }>
  aborted: Array<string>
}

const provider = (
  telemetry: OpenCodeSessionTelemetry | undefined,
  calls: ProviderCalls,
): AgentRunProviderPort => ({
  createSession: () => Effect.die(new Error("unused")),
  promptSession: (input) =>
    Effect.sync(() => {
      calls.prompted.push({ sessionID: input.sessionID, text: input.text })
    }),
  abortSession: (input) =>
    Effect.sync(() => {
      calls.aborted.push(input.sessionID)
      return true
    }),
  listProviders: () => Effect.die(new Error("unused")),
  listModels: () => Effect.die(new Error("unused")),
  sessionTelemetry: () => Effect.succeed(telemetry),
})

const wakes: Array<string> = []
const signals: WorkSignalPort = {
  subscribe: () => Effect.die(new Error("unused")),
  wake: (lane) =>
    Effect.sync(() => {
      wakes.push(lane)
    }),
}

/** Creates a verified run with 7 tokens observed at `at`. */
const seedVerifiedRun = Effect.gen(function* () {
  const sessions = yield* KernelSessionStore
  const store = yield* AgentRunStore
  yield* sessions.registerResource({
    resourceId: "run-resource",
    owningHostId: "mint",
    absolutePath: "/tmp/worktrees/agent-runs/x",
    kind: "worktree",
    createdAt: at,
  })
  yield* sessions.registerSession({
    sessionId: "opencode-session-ses_child",
    providerKind: "opencode",
    providerVersion: 1,
    providerId: "opencode-primary",
    serverId: "opencode-primary",
    owningHostId: "mint",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    nativeSessionId: "ses_child",
    resourceId: "run-resource",
    createdAt: at,
  })
  yield* store.create({
    runId: "agent-run-x",
    route: "implement",
    providerId: "zai-coding-plan",
    modelId: "glm-5.3-flash",
    agent: "remote-worker",
    repository: "workflowd",
    directory: "/tmp/worktrees/agent-runs/x",
    prompt: "Fix the flaky test",
    promptSha256: "b".repeat(64),
    parentSessionId: null,
    resumePrompt: null,
    maxAttempts: 2,
    createdAt: at,
  })
  yield* store.claimSpawn({ runId: "agent-run-x", now: at })
  yield* store.markSpawned({
    runId: "agent-run-x",
    resourceId: "run-resource",
    sessionId: "opencode-session-ses_child",
    nativeSessionId: "ses_child",
    worktreeBranch: "agent-run/x",
    now: at,
  })
  yield* store.markVerified({ runId: "agent-run-x", outputTokens: 7, now: at })
})

const iterate = (
  telemetry: OpenCodeSessionTelemetry | undefined,
  calls: ProviderCalls,
  now: Date,
  progressWindowMs = 10 * 60_000,
) =>
  runAgentRunWatchdogIteration({
    progressWindowMs,
    staleAfterMs: 60 * 60_000,
    now: () => now,
  }).pipe(
    Effect.provideService(AgentRunProvider, provider(telemetry, calls)),
    Effect.provideService(WorkSignal, signals),
  )

const observing = (
  outputTokens: number,
  idle = false,
  outcome?: "succeeded" | "failed" | "interrupted",
) =>
  ({
    directory: "/tmp/worktrees/agent-runs/x",
    outputTokens,
    updatedAtMs: at.getTime(),
    idle,
    ...(outcome === undefined ? {} : { outcome }),
  }) satisfies OpenCodeSessionTelemetry

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof storesLayer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(storesLayer)))

describe("agent-run watchdog", () => {
  test("records climbing token counters as progress", async () => {
    const calls: ProviderCalls = { prompted: [], aborted: [] }
    const result = await run(
      Effect.gen(function* () {
        yield* seedVerifiedRun
        const status = yield* iterate(observing(20), calls, minutes(5))
        const store = yield* AgentRunStore
        const record = yield* store.read("agent-run-x")
        return { status, record }
      }),
    )
    expect(result.status).toBe("idle")
    expect(result.record?.lastOutputTokens).toBe(20)
    expect(calls.aborted).toHaveLength(0)
  })

  test("interrupts a session with no progress past the window", async () => {
    const calls: ProviderCalls = { prompted: [], aborted: [] }
    const result = await run(
      Effect.gen(function* () {
        yield* seedVerifiedRun
        const withinWindow = yield* iterate(observing(7), calls, minutes(5))
        const abortedBefore = calls.aborted.length
        const pastWindow = yield* iterate(observing(7), calls, minutes(15))
        return { withinWindow, abortedBefore, pastWindow }
      }),
    )
    expect(result.withinWindow).toBe("idle")
    expect(result.abortedBefore).toBe(0)
    expect(result.pastWindow).toBe("worked")
    expect(calls.aborted).toEqual(["ses_child"])
  })

  test("re-prompts an interrupted idle session in place with a bounded attempt", async () => {
    const calls: ProviderCalls = { prompted: [], aborted: [] }
    const result = await run(
      Effect.gen(function* () {
        yield* seedVerifiedRun
        const status = yield* iterate(observing(7, true, "interrupted"), calls, minutes(15))
        const store = yield* AgentRunStore
        const record = yield* store.read("agent-run-x")
        return { status, record }
      }),
    )
    expect(result.status).toBe("worked")
    expect(result.record?.state).toBe("verified")
    expect(result.record?.attempt).toBe(2)
    expect(calls.prompted).toHaveLength(1)
    expect(calls.prompted[0]!.text).toContain("Continue the task")
    expect(calls.prompted[0]!.text).toContain("Fix the flaky test")
  })

  test("escalates to operator_required when attempts are exhausted", async () => {
    const calls: ProviderCalls = { prompted: [], aborted: [] }
    const result = await run(
      Effect.gen(function* () {
        yield* seedVerifiedRun
        yield* iterate(observing(7, true, "interrupted"), calls, minutes(15))
        yield* iterate(observing(7, true, "failed"), calls, minutes(30))
        const store = yield* AgentRunStore
        return yield* store.read("agent-run-x")
      }),
    )
    expect(result?.state).toBe("operator_required")
    expect(result?.diagnostic).toContain("attempts_exhausted")
    expect(calls.prompted).toHaveLength(1)
  })

  test("completes a succeeded idle session and wakes the completion lane", async () => {
    const calls: ProviderCalls = { prompted: [], aborted: [] }
    wakes.length = 0
    const result = await run(
      Effect.gen(function* () {
        yield* seedVerifiedRun
        const status = yield* iterate(observing(50, true, "succeeded"), calls, minutes(20))
        const store = yield* AgentRunStore
        const record = yield* store.read("agent-run-x")
        return { status, record }
      }),
    )
    expect(result.status).toBe("worked")
    expect(result.record?.state).toBe("completed")
    expect(wakes).toContain("agent-completion")
  })

  test("marks a vanished session operator_required", async () => {
    const calls: ProviderCalls = { prompted: [], aborted: [] }
    const result = await run(
      Effect.gen(function* () {
        yield* seedVerifiedRun
        yield* iterate(undefined, calls, minutes(5))
        const store = yield* AgentRunStore
        return yield* store.read("agent-run-x")
      }),
    )
    expect(result?.state).toBe("operator_required")
    expect(result?.diagnostic).toContain("missing_session")
  })

  test("fails a run abandoned before verification once it goes stale", async () => {
    const calls: ProviderCalls = { prompted: [], aborted: [] }
    const result = await run(
      Effect.gen(function* () {
        const store = yield* AgentRunStore
        yield* store.create({
          runId: "agent-run-y",
          route: "implement",
          providerId: "zai-coding-plan",
          modelId: "glm-5.3-flash",
          agent: "remote-worker",
          repository: "workflowd",
          directory: "/tmp/worktrees/agent-runs/y",
          prompt: "task",
          promptSha256: "c".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 3,
          createdAt: at,
        })
        const status = yield* iterate(observing(7), calls, minutes(90))
        return { status, record: yield* store.read("agent-run-y") }
      }),
    )
    expect(result.status).toBe("worked")
    expect(result.record?.state).toBe("failed")
    expect(result.record?.diagnostic).toContain("dispatch_incomplete")
  })
})

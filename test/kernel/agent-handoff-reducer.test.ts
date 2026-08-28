import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import {
  AgentHandoffStore,
  AgentHandoffStoreLive,
  recordAgentSessionCompletion,
} from "../../src/kernel/agent-handoff-store"
import { enqueueNextAgentHandoff } from "../../src/kernel/agent-handoff-reducer"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelJobStore, KernelJobStoreLive } from "../../src/kernel/job-store"
import { runKernelJobIteration } from "../../src/kernel/job-runner"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal, type WorkSignalPort } from "../../src/work-signal"

const at = new Date("2026-08-14T09:00:00.000Z")

const layer = (() => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  const events = KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap))
  const jobs = KernelJobStoreLive.pipe(Layer.provideMerge(bootstrap))
  const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
  const handoffs = AgentHandoffStoreLive.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(bootstrap),
  )
  return Layer.mergeAll(events, jobs, sessions, handoffs)
})()

const arrangeDelivery = Effect.gen(function* () {
  const sessions = yield* KernelSessionStore
  for (const name of ["child", "parent"] as const) {
    yield* sessions.registerResource({
      resourceId: `${name}-resource`,
      owningHostId: "mint",
      absolutePath: name === "child" ? process.cwd() : `${process.cwd()}/src`,
      kind: "worktree",
      createdAt: at,
    })
    yield* sessions.registerSession({
      sessionId: `${name}-stable`,
      providerKind: "opencode",
      providerVersion: 1,
      providerId: "opencode-primary",
      serverId: "server-a",
      owningHostId: "mint",
      endpointAlias: "local",
      endpointIdentity: "http://127.0.0.1:4096",
      nativeSessionId: `ses_${name}`,
      resourceId: `${name}-resource`,
      createdAt: at,
    })
  }
  const handoffs = yield* AgentHandoffStore
  yield* handoffs.register({
    instanceId: "handoff-1",
    waitId: "wait-child",
    workflow: {
      kind: "wait_for_agent",
      childSessionId: "child-stable",
      childSessionGeneration: 1,
      parentSessionId: "parent-stable",
      resumePrompt: { task: "Continue exactly." },
      resumePromptText: '{"task":"Continue exactly."}',
      outputContract: "test.parent-result",
      outputContractVersion: 1,
      retryPolicy: { maxAttempts: 3 },
    },
    completionSource: {
      owningHostId: "mint",
      providerId: "opencode-primary",
      serverId: "server-a",
      endpointAlias: "local",
      endpointIdentity: "http://127.0.0.1:4096",
      providerVersion: 1,
    },
    registeredAt: at,
  })
  yield* recordAgentSessionCompletion({
    source: "test-source",
    sourceEventId: "terminal-1",
    childSessionId: "child-stable",
    childSessionGeneration: 1,
    completionId: "completion-1",
    completedAt: at,
  })
})

describe("agent handoff reducer", () => {
  test("atomically consumes one delivery into one durable parent-resume action", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeDelivery
        const first = yield* enqueueNextAgentHandoff(at)
        const second = yield* enqueueNextAgentHandoff(at)
        return { first, second, job: yield* jobs.readJob("handoff-1:resume-parent") }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.first).toEqual({ status: "enqueued", jobId: "handoff-1:resume-parent" })
    expect(result.second).toEqual({ status: "idle" })
    expect(result.job).toMatchObject({ state: "ready", maxAttempts: 3 })
  })

  test("registers exactly one saved resume request and wakes its lane after commit", async () => {
    const wakes: Array<string> = []
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: (lane) => Effect.sync(() => void wakes.push(lane)),
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* KernelSessionStore
        yield* arrangeDelivery
        yield* enqueueNextAgentHandoff(at)
        const iteration = yield* runKernelJobIteration({
          workerId: "handoff-worker",
          now: () => at,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return {
          iteration,
          request: yield* sessions.readResumeRequest("handoff-1:resume-parent:request"),
        }
      }).pipe(Effect.provide(layer), Effect.provideService(WorkSignal, signals)),
    )

    expect(result.iteration).toEqual({ status: "completed", jobId: "handoff-1:resume-parent" })
    expect(result.request).toMatchObject({
      session_id: "parent-stable",
      prompt_text: '{"task":"Continue exactly."}',
      state: "ready",
    })
    expect(wakes).toEqual(["session-resume"])
  })

  test("replays harmlessly after crashing between resume registration and job completion", async () => {
    let crash = true
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* KernelSessionStore
        yield* arrangeDelivery
        yield* enqueueNextAgentHandoff(at)
        const first = yield* runKernelJobIteration({
          workerId: "handoff-worker-a",
          now: () => at,
          leaseDurationMs: 60_000,
          retryDelayMs: 0,
          afterResumeRegistered: () => {
            if (crash) {
              crash = false
              return Effect.fail(new Error("injected post-registration crash"))
            }
            return Effect.void
          },
        })
        const second = yield* runKernelJobIteration({
          workerId: "handoff-worker-b",
          now: () => at,
          leaseDurationMs: 60_000,
          retryDelayMs: 0,
        })
        return {
          first,
          second,
          recoverable: yield* sessions.readRecoverableResume("mint"),
        }
      }).pipe(Effect.provide(layer), Effect.provideService(WorkSignal, signals)),
    )

    expect(result.first).toMatchObject({ status: "retry_scheduled" })
    expect(result.second).toMatchObject({ status: "completed" })
    expect(result.recoverable).toHaveLength(1)
    expect(result.recoverable[0]).toMatchObject({ request_id: "handoff-1:resume-parent:request" })
  })
})

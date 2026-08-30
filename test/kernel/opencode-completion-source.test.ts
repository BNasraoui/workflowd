import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { AgentHandoffStore, AgentHandoffStoreLive } from "../../src/kernel/agent-handoff-store"
import { KernelEventStore, KernelEventStoreLive } from "../../src/kernel/event-store"
import { enqueueNextAgentHandoff } from "../../src/kernel/agent-handoff-reducer"
import { KernelJobStoreLive } from "../../src/kernel/job-store"
import { runKernelJobIteration } from "../../src/kernel/job-runner"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import {
  OpenCodeResumeProvider,
  runOpenCodeResumeIteration,
  type OpenCodeResumeProviderPort,
} from "../../src/kernel/opencode-resume-worker"
import {
  OpenCodeCompletionProvider,
  runOpenCodeCompletionSourceIteration,
  type OpenCodeCompletionProviderPort,
} from "../../src/kernel/opencode-completion-source"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal, type WorkSignalPort } from "../../src/work-signal"

const at = new Date("2026-08-14T09:00:00.000Z")
const childAnswer = {
  id: "msg_terminal_1",
  role: "assistant" as const,
  time: { created: at.getTime(), completed: at.getTime() + 1_000 },
}

const stores = (() => {
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

const arrange = Effect.gen(function* () {
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
      resumePrompt: { task: "Continue." },
      resumePromptText: '{"task":"Continue."}',
      outputContract: "test.parent-result",
      outputContractVersion: 1,
      retryPolicy: { maxAttempts: 3 },
    },
    completionSource: options,
    registeredAt: at,
  })
})

const options = {
  owningHostId: "mint",
  providerId: "opencode-primary",
  serverId: "server-a",
  endpointAlias: "local",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
  observationTimeoutMs: 5_000,
  now: () => at,
}

// The generator body only starts on the first next() pull, which can lose the
// race against observation cleanup — so honour an already-aborted signal too.
const abortAwareHangingStream = (signal: AbortSignal) =>
  (async function* () {
    yield* []
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  })()

describe("OpenCode agent completion source", () => {
  test("catches up history after the durable registration boundary", async () => {
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [childAnswer],
      subscribeEvents: async () => (async function* () {})(),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        const completed = yield* runOpenCodeCompletionSourceIteration(options)
        const rows = yield* sql`SELECT event_type FROM kernel_events`
        return { completed, rows }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.completed.status).toBe("completed")
    expect(result.rows).toHaveLength(1)
  })

  test("observes without prompting, commits one neutral fact, then wakes durable delivery work", async () => {
    const providerOperations: Array<string> = []
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => {
        providerOperations.push("sessionExists")
        return true
      },
      sessionFinished: async () => {
        providerOperations.push("sessionFinished")
        return true
      },
      listMessages: async () => {
        providerOperations.push("listMessages")
        return []
      },
      subscribeEvents: async () => {
        providerOperations.push("subscribeEvents")
        return (async function* () {
          providerOperations.push("streamStarted")
          yield { type: "message.updated" as const, sessionID: "ses_child", message: childAnswer }
        })()
      },
    }
    const wakes: Array<string> = []
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: (lane) => Effect.sync(() => void wakes.push(lane)),
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const events = yield* KernelEventStore
        yield* arrange
        const iteration = yield* runOpenCodeCompletionSourceIteration(options)
        const deliveries = yield* events.readReadyDeliveries("handoff-1")
        const rows = yield* sql<Record<string, unknown>>`SELECT * FROM kernel_events`
        const watch = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM kernel_agent_completion_watches`
        return { iteration, deliveries, rows, watch }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(providerOperations).toEqual([
      "sessionExists",
      "subscribeEvents",
      "streamStarted",
      "sessionFinished",
      "listMessages",
    ])
    expect(result.iteration).toMatchObject({ status: "completed", childSessionId: "child-stable" })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ event_type: "agent.session.completed" })
    expect(result.deliveries).toHaveLength(1)
    expect(result.watch[0]).toMatchObject({ state: "completed" })
    expect(wakes).toEqual(["kernel-job"])
  })

  test("catches up a completion missed before subscription and deduplicates reconnect replay", async () => {
    let subscriptions = 0
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [childAnswer],
      subscribeEvents: async () => {
        subscriptions += 1
        return (async function* () {
          yield { type: "message.updated" as const, sessionID: "ses_child", message: childAnswer }
        })()
      },
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        const first = yield* runOpenCodeCompletionSourceIteration(options)
        const second = yield* runOpenCodeCompletionSourceIteration(options)
        const eventCount = yield* sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM kernel_events`
        return { first, second, count: eventCount[0]!.count }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.first.status).toBe("completed")
    expect(result.second.status).toBe("idle")
    expect(result.count).toBe(1)
    expect(subscriptions).toBe(1)
  })

  test("escalates when the child completed before registration and nothing further happens", async () => {
    // The child finished while the registration round-trip was in flight: its
    // terminal answer predates the registration boundary and the live stream
    // will never replay it. The watch must escalate loudly, not park forever.
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [
        {
          id: "msg_stale",
          role: "assistant",
          time: { created: at.getTime() - 2_000, completed: at.getTime() - 1_000 },
        },
      ],
      subscribeEvents: async (_input, signal) => abortAwareHangingStream(signal),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        const iteration = yield* runOpenCodeCompletionSourceIteration(options)
        const events = yield* sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM kernel_events`
        const watch = yield* sql<{
          readonly state: string
        }>`SELECT state FROM kernel_agent_completion_watches`
        return { iteration, count: events[0]!.count, watchState: watch[0]!.state }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.iteration).toMatchObject({
      status: "operator_required",
      reason: "stale_completion",
    })
    expect(result.count).toBe(0)
    expect(result.watchState).toBe("operator_required")
  })

  test("ignores an already-recorded stale answer and accepts a live completion", async () => {
    // A second wait on the same child sees the first wait's consumed answer in
    // provider history. That answer is stale for the new boundary but already
    // recorded as a completion event, so the watch keeps waiting live.
    const secondAnswer = {
      id: "msg_terminal_next",
      role: "assistant" as const,
      time: { created: at.getTime() + 2_500, completed: at.getTime() + 3_000 },
    }
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [childAnswer],
      subscribeEvents: async () =>
        (async function* () {
          yield { type: "message.updated" as const, sessionID: "ses_child", message: secondAnswer }
        })(),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const handoffs = yield* AgentHandoffStore
        yield* arrange
        const first = yield* runOpenCodeCompletionSourceIteration(options)
        yield* handoffs.register({
          instanceId: "handoff-2",
          waitId: "wait-child-2",
          workflow: {
            kind: "wait_for_agent",
            childSessionId: "child-stable",
            childSessionGeneration: 1,
            parentSessionId: "parent-stable",
            resumePrompt: { task: "Continue again." },
            resumePromptText: '{"task":"Continue again."}',
            outputContract: "test.parent-result",
            outputContractVersion: 1,
            retryPolicy: { maxAttempts: 3 },
          },
          completionSource: options,
          registeredAt: new Date(at.getTime() + 2_000),
        })
        const second = yield* runOpenCodeCompletionSourceIteration(options)
        const events = yield* sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM kernel_events WHERE event_type = 'agent.session.completed'`
        return { first, second, count: events[0]!.count }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.first.status).toBe("completed")
    expect(result.second.status).toBe("completed")
    expect(result.count).toBe(2)
  })

  test("ignores a stale terminal event replayed by the live subscription", async () => {
    const stale = {
      id: "msg_stale_replay",
      role: "assistant" as const,
      time: { created: at.getTime() - 2_000, completed: at.getTime() - 1_000 },
    }
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [],
      subscribeEvents: async () =>
        (async function* () {
          yield { type: "message.updated" as const, sessionID: "ses_child", message: stale }
          yield { type: "message.updated" as const, sessionID: "ses_child", message: childAnswer }
        })(),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        const iteration = yield* runOpenCodeCompletionSourceIteration(options)
        const events = yield* sql<{
          readonly payload_json: string
        }>`SELECT payload_json FROM kernel_events`
        return { iteration, payload: JSON.parse(events[0]!.payload_json) }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.iteration.status).toBe("completed")
    expect(result.payload.completedAt).toBe(new Date(childAnswer.time.completed).toISOString())
  })

  test("quarantines unbounded catch-up history and a corrupt registration boundary", async () => {
    const flood = Array.from({ length: 21 }, (_, index) => ({
      id: `msg_${index}`,
      role: "assistant" as const,
      time: { created: at.getTime(), completed: at.getTime() + 1_000 + index },
    }))
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => flood,
      subscribeEvents: async () => (async function* () {})(),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        yield* sql`UPDATE kernel_agent_completion_watches SET registered_at = 'not-a-date'
          WHERE instance_id = 'handoff-1'`
        const corrupt = yield* runOpenCodeCompletionSourceIteration(options)
        yield* sql`UPDATE kernel_agent_completion_watches SET state = 'watching',
          registered_at = ${at.toISOString()} WHERE instance_id = 'handoff-1'`
        const flooded = yield* runOpenCodeCompletionSourceIteration(options)
        return { corrupt, flooded }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.corrupt).toMatchObject({
      status: "operator_required",
      reason: "corrupt_saved_watch",
    })
    expect(result.flooded).toMatchObject({
      status: "operator_required",
      reason: "history_exceeds_bound",
    })
  })

  test("a stuck watch yields its slot so a newer watch still completes", async () => {
    // Watch 1's child never produces a terminal answer, so its observation
    // times out. That must rotate it to the back of the queue instead of
    // head-of-line-blocking watch 2, whose child has already completed.
    const secondChildAnswer = {
      id: "msg_terminal_second_child",
      role: "assistant" as const,
      time: { created: at.getTime() + 4_000, completed: at.getTime() + 5_000 },
    }
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async (input) => (input.sessionID === "ses_child2" ? [secondChildAnswer] : []),
      subscribeEvents: async (_input, signal) => abortAwareHangingStream(signal),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }
    const impatient = {
      ...options,
      observationTimeoutMs: 50,
      now: () => new Date(at.getTime() + 60_000),
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const sessions = yield* KernelSessionStore
        const handoffs = yield* AgentHandoffStore
        yield* arrange
        yield* sessions.registerResource({
          resourceId: "child2-resource",
          owningHostId: "mint",
          absolutePath: `${process.cwd()}/test`,
          kind: "worktree",
          createdAt: at,
        })
        yield* sessions.registerSession({
          sessionId: "child2-stable",
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "opencode-primary",
          serverId: "server-a",
          owningHostId: "mint",
          endpointAlias: "local",
          endpointIdentity: "http://127.0.0.1:4096",
          nativeSessionId: "ses_child2",
          resourceId: "child2-resource",
          createdAt: at,
        })
        yield* handoffs.register({
          instanceId: "handoff-2",
          waitId: "wait-child-2",
          workflow: {
            kind: "wait_for_agent",
            childSessionId: "child2-stable",
            childSessionGeneration: 1,
            parentSessionId: "parent-stable",
            resumePrompt: { task: "Continue." },
            resumePromptText: '{"task":"Continue."}',
            outputContract: "test.parent-result",
            outputContractVersion: 1,
            retryPolicy: { maxAttempts: 3 },
          },
          completionSource: options,
          registeredAt: new Date(at.getTime() + 1_000),
        })
        const first = yield* runOpenCodeCompletionSourceIteration(impatient)
        const second = yield* runOpenCodeCompletionSourceIteration(impatient)
        const watches = yield* sql<{
          readonly instance_id: string
          readonly state: string
        }>`SELECT instance_id, state FROM kernel_agent_completion_watches ORDER BY instance_id`
        return { first, second, watches }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.first).toMatchObject({ status: "yielded", instanceId: "handoff-1" })
    expect(result.second).toMatchObject({ status: "completed", childSessionId: "child2-stable" })
    expect(result.watches).toEqual([
      { instance_id: "handoff-1", state: "watching" },
      { instance_id: "handoff-2", state: "completed" },
    ])
  })

  test("quarantines custody mismatch without calling the provider", async () => {
    let providerCalls = 0
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => {
        providerCalls += 1
        return true
      },
      sessionFinished: async () => {
        providerCalls += 1
        return true
      },
      listMessages: async () => [],
      subscribeEvents: async () => (async function* () {})(),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* arrange
        return yield* runOpenCodeCompletionSourceIteration({
          ...options,
          providerId: "wrong-provider",
        })
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result).toMatchObject({ status: "operator_required", reason: "custody_mismatch" })
    expect(providerCalls).toBe(0)
  })

  test("never completes a still-running child from its mid-turn step messages", async () => {
    // The live premature-wake regression (workflowd-hcq): OpenCode 2 completes
    // an assistant message per tool step, so a busy child already has
    // completed messages in history. Until the run has ended they are not
    // answers; the watch must keep waiting, not complete or escalate.
    let historyReads = 0
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: async () => false,
      listMessages: async () => {
        historyReads += 1
        return [
          childAnswer,
          {
            ...childAnswer,
            id: "msg_step_2",
            time: { ...childAnswer.time, completed: childAnswer.time.completed + 1 },
          },
        ]
      },
      subscribeEvents: async (_input, signal) => abortAwareHangingStream(signal),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        const iteration = yield* runOpenCodeCompletionSourceIteration({
          ...options,
          observationTimeoutMs: 50,
        })
        const events = yield* sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM kernel_events`
        const watch = yield* sql<
          Record<string, unknown>
        >`SELECT state FROM kernel_agent_completion_watches`
        return { iteration, count: events[0]!.count, watch }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.iteration).toMatchObject({ status: "yielded" })
    expect(result.count).toBe(0)
    expect(result.watch[0]).toMatchObject({ state: "watching" })
    // History is never consulted while the run is live; the terminal signal
    // is the finished probe plus the execution-succeeded live event.
    expect(historyReads).toBe(0)
  })

  test("attributes the latest completed message of a finished multi-step run", async () => {
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [
        childAnswer,
        {
          ...childAnswer,
          id: "msg_terminal_2",
          time: { ...childAnswer.time, completed: childAnswer.time.completed + 1 },
        },
      ],
      subscribeEvents: async () => (async function* () {})(),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrange
        const iteration = yield* runOpenCodeCompletionSourceIteration(options)
        const events = yield* sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM kernel_events`
        return { iteration, count: events[0]!.count }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    // OpenCode 2 completes an assistant message per tool step, so several
    // fresh completed messages are one finished answer, not ambiguity.
    expect(result.iteration).toMatchObject({ status: "completed" })
    expect(result.count).toBe(1)
  })

  test("continues the parent end to end through the existing resume worker", async () => {
    let parentPrompts = 0
    const completionProvider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [],
      subscribeEvents: async () =>
        (async function* () {
          yield { type: "message.updated" as const, sessionID: "ses_child", message: childAnswer }
        })(),
    }
    const resumeProvider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      sessionFinished: () => Promise.resolve(true),
      listMessages: async () => [],
      promptAsync: async () => {
        parentPrompts += 1
      },
      subscribeEvents: async () =>
        (async function* () {
          yield {
            type: "message.updated" as const,
            sessionID: "ses_parent",
            message: {
              id: "parent-result",
              role: "assistant" as const,
              time: { created: at.getTime() + 2_000, completed: at.getTime() + 3_000 },
            },
          }
        })(),
      generate: async () => ({ answer: "continued" }),
    }
    const signals: WorkSignalPort = {
      subscribe: () => Effect.die(new Error("unused")),
      wake: () => Effect.void,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* KernelSessionStore
        yield* arrange
        yield* runOpenCodeCompletionSourceIteration(options)
        yield* enqueueNextAgentHandoff(at)
        yield* runKernelJobIteration({
          workerId: "handoff-worker",
          now: () => at,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        const resumed = yield* runOpenCodeResumeIteration({
          ...options,
          workerId: "resume-worker",
          leaseDurationMs: 60_000,
          heartbeatIntervalMs: 10_000,
          contracts: [
            {
              name: "test.parent-result",
              version: 1,
              schema: Schema.Struct({ answer: Schema.String }),
              jsonSchema: { type: "object", required: ["answer"] },
              agent: "parent-agent",
              model: { providerID: "openai", modelID: "gpt-5.6-sol" },
              maxOutputBytes: 1_024,
            },
          ],
        })
        return {
          resumed,
          stored: yield* sessions.readResumeResult("handoff-1:resume-parent:request"),
        }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, completionProvider),
        Effect.provideService(OpenCodeResumeProvider, resumeProvider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.resumed).toMatchObject({ status: "completed" })
    expect(result.stored).toMatchObject({ result_json: '{"answer":"continued"}' })
    expect(parentPrompts).toBe(1)
  })
})

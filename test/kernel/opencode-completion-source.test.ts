import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
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
  registerOpenCodeAgentWait,
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
    baseline: { version: 1, messageFingerprints: [] },
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
  now: () => at,
}

describe("OpenCode agent completion source", () => {
  test("captures bounded history after persisting the workflow boundary and before activating the watch", async () => {
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
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
        const registered = yield* registerOpenCodeAgentWait(
          {
            instanceId: "registered-through-adapter",
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
            registeredAt: at,
          },
          options,
        )
        const rows = yield* sql<{ readonly baseline_json: string }>`SELECT baseline_json
          FROM kernel_agent_completion_watches WHERE instance_id = 'registered-through-adapter'`
        return { registered, baseline: JSON.parse(rows[0]!.baseline_json) }
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(OpenCodeCompletionProvider, provider),
        Effect.provideService(WorkSignal, signals),
      ),
    )

    expect(result.registered.status).toBe("registered")
    expect(result.baseline.messageFingerprints).toEqual(["id:msg_terminal_1"])
  })

  test("observes without prompting, commits one neutral fact, then wakes durable delivery work", async () => {
    const prompts = 0
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      subscribeEvents: async () =>
        (async function* () {
          yield { type: "message.updated" as const, sessionID: "ses_child", message: childAnswer }
        })(),
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

    expect(prompts).toBe(0)
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

  test("fails closed when bounded history contains only a stale terminal answer", async () => {
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [
        {
          id: "msg_stale",
          role: "assistant",
          time: { created: at.getTime() - 2_000, completed: at.getTime() - 1_000 },
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

    expect(result.iteration).toMatchObject({
      status: "operator_required",
      reason: "stale_completion",
    })
    expect(result.count).toBe(0)
  })

  test("quarantines custody mismatch without calling the provider", async () => {
    let providerCalls = 0
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => {
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

  test("quarantines ambiguous catch-up history without recording a completion", async () => {
    const provider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
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

    expect(result.iteration).toMatchObject({
      status: "operator_required",
      reason: "ambiguous_new_answers",
    })
    expect(result.count).toBe(0)
  })

  test("continues the parent end to end through the existing resume worker", async () => {
    let parentPrompts = 0
    const completionProvider: OpenCodeCompletionProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      subscribeEvents: async () =>
        (async function* () {
          yield { type: "message.updated" as const, sessionID: "ses_child", message: childAnswer }
        })(),
    }
    const resumeProvider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
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
              structured: { answer: "continued" },
            },
          }
        })(),
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

import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect, Fiber, Layer, Schema } from "effect"
import { KernelSessionStore } from "../../src/kernel/session-store"
import {
  OpenCodeResumeAdapter,
  OpenCodeResumeProvider,
  runOpenCodeResumeIteration,
  type OpenCodeResumeProviderPort,
} from "../../src/kernel/opencode-resume-worker"
import { runSessionKernel } from "./session-store-harness"

const startedAt = new Date("2026-08-14T08:00:00.000Z")
const directory = process.cwd()

const registerRequest = Effect.gen(function* () {
  const store = yield* KernelSessionStore
  yield* store.registerResource({
    resourceId: "resource-1",
    owningHostId: "mint",
    absolutePath: directory,
    kind: "worktree",
    createdAt: startedAt,
  })
  yield* store.registerSession({
    sessionId: "session-1",
    providerKind: "opencode",
    providerVersion: 1,
    providerId: "opencode-primary",
    serverId: "opencode-primary",
    owningHostId: "mint",
    endpointAlias: "private-opencode",
    endpointIdentity: "http://127.0.0.1:4096",
    nativeSessionId: "ses_exact",
    resourceId: "resource-1",
    createdAt: startedAt,
  })
  const promptText = '{"task":"continue exactly"}'
  yield* store.registerResumeRequest({
    requestId: "resume-1",
    sessionId: "session-1",
    owningHostId: "mint",
    prompt: { task: "continue exactly" },
    promptText,
    promptSha256: createHash("sha256").update(promptText).digest("hex"),
    outputContract: "test.answer",
    outputContractVersion: 1,
    maxAttempts: 3,
    runAt: startedAt,
    createdAt: startedAt,
  })
})

const options = {
  owningHostId: "mint",
  workerId: "resume-worker",
  providerId: "opencode-primary",
  serverId: "opencode-primary",
  endpointAlias: "private-opencode",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
  leaseDurationMs: 60_000,
  heartbeatIntervalMs: 10_000,
  now: () => startedAt,
  contracts: [
    {
      name: "test.answer",
      version: 1,
      schema: Schema.Struct({ answer: Schema.String }),
      jsonSchema: { type: "object", required: ["answer"] },
      agent: "resume-agent",
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      maxOutputBytes: 1_024,
    },
  ],
}

describe("OpenCode local resume worker", () => {
  test("adapts the saved prompt to OpenCode promptAsync without changing its text", async () => {
    let prompted: unknown
    const adapter = new OpenCodeResumeAdapter({
      createSession: async () => ({ id: "unused" }),
      promptSession: async (input) => {
        prompted = input
      },
      subscribeSessionEvents: async () => (async function* () {})(),
      getSessionStatus: async () => ({ type: "idle" }),
      sessionExists: async () => true,
      listSessionMessages: async () => [],
      abortSession: async () => true,
      validateAvailability: async () => undefined,
    })

    await adapter.promptAsync(
      {
        sessionID: "ses_exact",
        directory,
        prompt: '{"task":"continue exactly"}',
        agent: "resume-agent",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        jsonSchema: { type: "object" },
      },
      new AbortController().signal,
    )

    expect(prompted).toMatchObject({
      parts: [{ type: "text", text: '{"task":"continue exactly"}' }],
      format: { type: "json_schema", retryCount: 2 },
    })
  })

  test("retries safely when the first worker crashes before the durable sent fence", async () => {
    let prompts = 0
    let baselineReads = 0
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => {
        baselineReads += 1
        if (baselineReads === 1) throw new Error("simulated crash before sent")
        return []
      },
      promptAsync: async () => {
        prompts += 1
      },
      subscribeEvents: async () =>
        (async function* () {
          yield {
            type: "message.updated" as const,
            sessionID: "ses_exact",
            message: {
              role: "assistant" as const,
              time: { created: 1, completed: 2 },
              structured: { answer: "done" },
            },
          }
        })(),
    }
    const Provider = Layer.succeed(OpenCodeResumeProvider, provider)

    const outcome = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* registerRequest
        const crashed = yield* runOpenCodeResumeIteration(options).pipe(
          Effect.provide(Provider),
          Effect.either,
        )
        const first = yield* store.readResumeRequest("resume-1")
        const retried = yield* runOpenCodeResumeIteration({
          ...options,
          workerId: "replacement-worker",
          now: () => new Date(startedAt.getTime() + 60_000),
        }).pipe(Effect.provide(Provider))
        return { crashed, first, retried, result: yield* store.readResumeResult("resume-1") }
      }),
    )

    expect(outcome.crashed._tag).toBe("Left")
    expect(outcome.first).toMatchObject({ state: "leased", attempt: 1 })
    expect(outcome.retried).toMatchObject({ status: "completed", requestId: "resume-1" })
    expect(outcome.result).toMatchObject({ result_json: '{"answer":"done"}', attempt: 2 })
    expect(prompts).toBe(1)
  })

  test("observes without resending after durable sent but before provider acceptance", async () => {
    let prompts = 0
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      promptAsync: async () => {
        prompts += 1
        throw new Error("connection lost before acceptance was knowable")
      },
      subscribeEvents: async () => (async function* () {})(),
    }
    const Provider = Layer.succeed(OpenCodeResumeProvider, provider)

    const outcome = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* registerRequest
        const first = yield* runOpenCodeResumeIteration(options).pipe(
          Effect.provide(Provider),
          Effect.either,
        )
        const restarted = yield* runOpenCodeResumeIteration({
          ...options,
          workerId: "replacement-worker",
          now: () => new Date(startedAt.getTime() + 60_000),
        }).pipe(Effect.provide(Provider))
        return {
          first,
          restarted,
          request: yield* store.readResumeRequest("resume-1"),
          observation: yield* store.readLatestObservation("resume-1"),
        }
      }),
    )

    expect(outcome.first._tag).toBe("Left")
    expect(outcome.restarted).toMatchObject({
      status: "operator_required",
      requestId: "resume-1",
    })
    expect(outcome.request).toMatchObject({ state: "operator_required", attempt: 1 })
    expect(outcome.observation).toMatchObject({ disposition: "operator_required" })
    expect(prompts).toBe(1)
  })

  test("recovers an accepted answer from history without re-prompting after result commit crashes", async () => {
    let prompts = 0
    let accepted = false
    let clock = startedAt
    const answer = {
      role: "assistant" as const,
      time: { created: 10, completed: 20 },
      structured: { answer: "recovered" },
    }
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => (accepted ? [answer] : []),
      promptAsync: async () => {
        prompts += 1
        accepted = true
      },
      subscribeEvents: async () =>
        (async function* () {
          clock = new Date(startedAt.getTime() + 60_000)
          yield { type: "message.updated" as const, sessionID: "ses_exact", message: answer }
        })(),
    }
    const Provider = Layer.succeed(OpenCodeResumeProvider, provider)

    const outcome = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* registerRequest
        const first = yield* runOpenCodeResumeIteration({ ...options, now: () => clock }).pipe(
          Effect.provide(Provider),
          Effect.either,
        )
        const restarted = yield* runOpenCodeResumeIteration({
          ...options,
          workerId: "replacement-worker",
          now: () => clock,
        }).pipe(Effect.provide(Provider))
        return {
          first,
          restarted,
          request: yield* store.readResumeRequest("resume-1"),
          observation: yield* store.readLatestObservation("resume-1"),
          result: yield* store.readResumeResult("resume-1"),
        }
      }),
    )

    expect(outcome.first._tag).toBe("Left")
    expect(outcome.restarted).toMatchObject({ status: "completed", requestId: "resume-1" })
    expect(outcome.request).toMatchObject({ state: "completed", attempt: 1 })
    expect(outcome.observation).toMatchObject({
      disposition: "completed",
      evidence_json: expect.stringContaining('"answer":"recovered"'),
    })
    expect(outcome.result).toMatchObject({
      result_json: '{"answer":"recovered"}',
      attempt: 1,
    })
    expect(prompts).toBe(1)
  })

  test("heartbeats its exact claim while waiting on provider events", async () => {
    const wallStart = Date.now()
    const clock = () => new Date(startedAt.getTime() + (Date.now() - wallStart))
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      promptAsync: async () => undefined,
      subscribeEvents: async () =>
        (async function* () {
          await Bun.sleep(30)
          yield {
            type: "message.updated" as const,
            sessionID: "ses_exact",
            message: {
              role: "assistant" as const,
              time: { created: 1, completed: 2 },
              structured: { answer: "after-heartbeats" },
            },
          }
        })(),
    }

    const outcome = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        yield* registerRequest
        return yield* runOpenCodeResumeIteration({
          ...options,
          leaseDurationMs: 20,
          heartbeatIntervalMs: 5,
          now: clock,
        }).pipe(Effect.provide(Layer.succeed(OpenCodeResumeProvider, provider)))
      }),
    )

    expect(outcome).toMatchObject({ status: "completed", requestId: "resume-1" })
  })

  test("requires operator action before provider access when the saved endpoint is wrong", async () => {
    let providerCalls = 0
    const touched = async () => {
      providerCalls += 1
      return true
    }
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: touched,
      listMessages: async () => [],
      promptAsync: async () => undefined,
      subscribeEvents: async () => (async function* () {})(),
    }

    const outcome = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* registerRequest
        const result = yield* runOpenCodeResumeIteration({
          ...options,
          endpointIdentity: "http://replacement.invalid:4096",
        }).pipe(Effect.provide(Layer.succeed(OpenCodeResumeProvider, provider)))
        return { result, request: yield* store.readResumeRequest("resume-1") }
      }),
    )

    expect(outcome.result).toMatchObject({ status: "operator_required", requestId: "resume-1" })
    expect(outcome.request).toMatchObject({ state: "operator_required" })
    expect(providerCalls).toBe(0)
  })

  test("marks a missing native provider session explicitly without prompting", async () => {
    let prompts = 0
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => false,
      listMessages: async () => [],
      promptAsync: async () => {
        prompts += 1
      },
      subscribeEvents: async () => (async function* () {})(),
    }

    const outcome = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* KernelSessionStore
        yield* registerRequest
        const result = yield* runOpenCodeResumeIteration(options).pipe(
          Effect.provide(Layer.succeed(OpenCodeResumeProvider, provider)),
        )
        return {
          result,
          request: yield* store.readResumeRequest("resume-1"),
          session: yield* store.readSession("session-1"),
        }
      }),
    )

    expect(outcome.result).toMatchObject({ status: "missing", requestId: "resume-1" })
    expect(outcome.request).toMatchObject({ state: "failed" })
    expect(outcome.session).toMatchObject({ state: "missing" })
    expect(prompts).toBe(0)
  })

  test("opens event observation after the sent fence and before promptAsync", async () => {
    const actions: Array<string> = []
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      promptAsync: async () => {
        actions.push("prompt")
      },
      subscribeEvents: async () => {
        actions.push("subscribe")
        return (async function* () {
          yield {
            type: "message.updated" as const,
            sessionID: "ses_exact",
            message: {
              role: "assistant" as const,
              time: { created: 1, completed: 2 },
              structured: { answer: "observed" },
            },
          }
        })()
      },
    }

    await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        yield* registerRequest
        yield* runOpenCodeResumeIteration(options).pipe(
          Effect.provide(Layer.succeed(OpenCodeResumeProvider, provider)),
        )
      }),
    )

    expect(actions).toEqual(["subscribe", "prompt"])
  })

  test("allows only one concurrent local worker to prompt a saved request", async () => {
    let prompts = 0
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      promptAsync: async () => {
        prompts += 1
      },
      subscribeEvents: async () =>
        (async function* () {
          yield {
            type: "message.updated" as const,
            sessionID: "ses_exact",
            message: {
              role: "assistant" as const,
              time: { created: 1, completed: 2 },
              structured: { answer: "once" },
            },
          }
        })(),
    }
    const Provider = Layer.succeed(OpenCodeResumeProvider, provider)

    const outcomes = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        yield* registerRequest
        return yield* Effect.all(
          ["worker-a", "worker-b"].map((workerId) =>
            runOpenCodeResumeIteration({ ...options, workerId }).pipe(Effect.provide(Provider)),
          ),
          { concurrency: "unbounded" },
        )
      }),
    )

    expect(outcomes.map(({ status }) => status).sort()).toEqual(["completed", "idle"])
    expect(prompts).toBe(1)
  })

  test("wrong host and provider identities never reach OpenCode", async () => {
    let providerCalls = 0
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => {
        providerCalls += 1
        return true
      },
      listMessages: async () => [],
      promptAsync: async () => undefined,
      subscribeEvents: async () => (async function* () {})(),
    }
    const mismatches = [
      { owningHostId: "other-host" },
      { providerId: "other-provider" },
      { serverId: "other-server" },
      { endpointAlias: "other-endpoint" },
      { endpointIdentity: "http://other.invalid:4096" },
      { providerVersion: 2 },
    ]

    const statuses = await Promise.all(
      mismatches.map((mismatch) =>
        runSessionKernel(
          ":memory:",
          Effect.gen(function* () {
            yield* registerRequest
            return yield* runOpenCodeResumeIteration({ ...options, ...mismatch }).pipe(
              Effect.provide(Layer.succeed(OpenCodeResumeProvider, provider)),
              Effect.map((result) => result.status),
            )
          }),
        ),
      ),
    )

    expect(statuses).toEqual([
      "idle",
      "operator_required",
      "operator_required",
      "operator_required",
      "operator_required",
      "operator_required",
    ])
    expect(providerCalls).toBe(0)
  })

  test("interrupts active OpenCode observation on scoped worker shutdown", async () => {
    const prompted = Promise.withResolvers<void>()
    let observationAborted = false
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      promptAsync: async () => {
        prompted.resolve()
      },
      subscribeEvents: async (_input, signal) =>
        (async function* () {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observationAborted = true
                resolve()
              },
              { once: true },
            )
          })
          if (signal.aborted) return
          yield {
            type: "session.status" as const,
            sessionID: "ses_exact",
            status: { type: "idle" as const },
          }
        })(),
    }

    await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        yield* registerRequest
        const worker = yield* Effect.fork(
          runOpenCodeResumeIteration(options).pipe(
            Effect.provide(Layer.succeed(OpenCodeResumeProvider, provider)),
          ),
        )
        yield* Effect.promise(() => prompted.promise)
        yield* Fiber.interrupt(worker)
      }),
    )

    expect(observationAborted).toBe(true)
  })

  test("stops a late worker when heartbeat authority is lost", async () => {
    const prompted = Promise.withResolvers<void>()
    const wallStart = Date.now()
    const provider: OpenCodeResumeProviderPort = {
      sessionExists: async () => true,
      listMessages: async () => [],
      promptAsync: async () => prompted.resolve(),
      subscribeEvents: async (_input, signal) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
          if (signal.aborted) return
          yield {
            type: "session.status" as const,
            sessionID: "ses_exact",
            status: { type: "idle" as const },
          }
        })(),
    }

    const outcome = await runSessionKernel(
      ":memory:",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* KernelSessionStore
        yield* registerRequest
        const worker = yield* Effect.fork(
          runOpenCodeResumeIteration({
            ...options,
            leaseDurationMs: 100,
            heartbeatIntervalMs: 5,
            now: () => new Date(startedAt.getTime() + (Date.now() - wallStart)),
          }).pipe(Effect.provide(Layer.succeed(OpenCodeResumeProvider, provider))),
        )
        yield* Effect.promise(() => prompted.promise)
        yield* sql`UPDATE kernel_resume_attempts SET claim_token = 'replacement'
          WHERE request_id = 'resume-1' AND attempt = 1`
        return {
          exit: yield* Fiber.await(worker),
          request: yield* store.readResumeRequest("resume-1"),
          result: yield* store.readResumeResult("resume-1"),
        }
      }),
    )

    expect(outcome.exit._tag).toBe("Failure")
    expect(outcome.request).toMatchObject({ state: "sent" })
    expect(outcome.result).toBeNull()
  })
})

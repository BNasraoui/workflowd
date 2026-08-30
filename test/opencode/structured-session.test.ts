import { describe, expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import {
  OpenCodeAdapterError,
  type OpenCodeAdapter,
  type OpenCodeSessionEvent,
} from "../../src/opencode/adapter"
import { StructuredSession, StructuredSessionError } from "../../src/opencode/structured-session"

const completedAt = (sessionID: string): OpenCodeSessionEvent => ({
  type: "message.updated",
  sessionID,
  message: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } },
})

function makeAdapter(overrides: Partial<OpenCodeAdapter> = {}): OpenCodeAdapter {
  return {
    createSession: () => Effect.succeed({ id: "ses_structured" }),
    promptSession: () => Effect.void,
    subscribeSessionEvents: () => Stream.fromIterable([completedAt("ses_structured")]),
    getSessionStatus: () => Effect.succeed({ type: "busy" as const }),
    sessionExists: () => Effect.succeed(true),
    listSessionMessages: () =>
      Effect.succeed([
        { id: "msg_1", role: "assistant" as const, time: { created: 1, completed: 2 } },
      ]),
    abortSession: () => Effect.succeed(true),
    validateAvailability: () => Effect.void,
    generateStructured: () => Effect.succeed({ verdict: "pass" }),
    ...overrides,
  }
}

const request = {
  directory: "/tmp/worktree",
  title: "review:owner/repo#7@abc123",
  agent: "pr-reviewer",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  outputJsonSchema: { type: "object" },
  retryCount: 2,
  prompt: "Review the pull request.",
  pollIntervalMs: 0,
  maxOutputBytes: 4 * 1024 * 1024,
}

const resultSchema = Schema.Struct({ verdict: Schema.Literal("pass") })

const runFailure = async <A>(effect: Effect.Effect<A, StructuredSessionError>) => {
  const result = await Effect.runPromise(Effect.result(effect))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("expected failure")
  return result.failure
}

describe("StructuredSession", () => {
  test("keeps the working prompt authored and moves the schema to extraction", async () => {
    const prompts: Array<string> = []
    const extractions: Array<{ readonly jsonSchema: object; readonly feedback?: string }> = []
    const adapter = makeAdapter({
      promptSession: (input) => {
        prompts.push(input.text)
        return Effect.void
      },
      generateStructured: (input) => {
        extractions.push({
          jsonSchema: input.jsonSchema,
          ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
        })
        return Effect.succeed({ verdict: "pass" })
      },
    })

    const result = await Effect.runPromise(
      new StructuredSession(adapter, request, resultSchema).run(),
    )

    expect(result).toEqual({ verdict: "pass" })
    expect(prompts).toEqual(["Review the pull request."])
    expect(extractions).toEqual([{ jsonSchema: { type: "object" } }])
  })

  test("retries extraction with validation feedback without touching the session", async () => {
    const prompts: Array<string> = []
    const feedbacks: Array<string | undefined> = []
    let extraction = 0
    const adapter = makeAdapter({
      promptSession: (input) => {
        prompts.push(input.text)
        return Effect.void
      },
      generateStructured: (input) => {
        feedbacks.push(input.feedback)
        extraction += 1
        return Effect.succeed(extraction === 1 ? { verdict: "unexpected" } : { verdict: "pass" })
      },
    })

    const result = await Effect.runPromise(
      new StructuredSession(adapter, request, resultSchema).run(),
    )

    expect(result).toEqual({ verdict: "pass" })
    expect(prompts).toEqual(["Review the pull request."])
    expect(feedbacks[0]).toBeUndefined()
    expect(feedbacks[1]).toBeDefined()
  })

  test("fails after exhausting extraction retries on invalid output", async () => {
    let extractions = 0
    const adapter = makeAdapter({
      generateStructured: () => {
        extractions += 1
        return Effect.succeed({ verdict: "unexpected" })
      },
    })

    const failure = await runFailure(new StructuredSession(adapter, request, resultSchema).run())
    expect(failure).toBeInstanceOf(StructuredSessionError)
    expect(failure.message).toContain("decode structured session output")
    expect(extractions).toBe(request.retryCount + 1)
  })

  test("rejects schema-valid structured output beyond the durable output envelope", async () => {
    const adapter = makeAdapter({
      generateStructured: () => Effect.succeed({ value: "x".repeat(4 * 1024 * 1024) }),
    })
    const schema = Schema.Struct({
      value: Schema.String.pipe(Schema.check(Schema.isMaxLength(5 * 1024 * 1024))),
    })

    const failure = await runFailure(new StructuredSession(adapter, request, schema).run())
    expect(failure.message).toContain("decode structured session output")
  })

  test("rejects structured output beyond the trusted harness declaration", async () => {
    const adapter = makeAdapter({
      generateStructured: () => Effect.succeed({ value: "x".repeat(100) }),
    })
    const schema = Schema.Struct({
      value: Schema.String.pipe(Schema.check(Schema.isMaxLength(100))),
    })

    const failure = await runFailure(
      new StructuredSession(adapter, { ...request, maxOutputBytes: 50 }, schema).run(),
    )
    expect(failure.message).toContain("decode structured session output")
  })

  test("creates a native session without prompting until the caller resumes it", async () => {
    const actions: Array<string> = []
    const adapter = makeAdapter({
      createSession: () => {
        actions.push("create")
        return Effect.succeed({ id: "ses_checkpointed" })
      },
      promptSession: () => {
        actions.push("prompt")
        return Effect.void
      },
      subscribeSessionEvents: () => Stream.fromIterable([completedAt("ses_checkpointed")]),
    })
    const session = new StructuredSession(adapter, request, resultSchema)

    const created = await Effect.runPromise(session.create())

    expect(created).toEqual({ sessionID: "ses_checkpointed", directory: "/tmp/worktree" })
    expect(actions).toEqual(["create"])

    const result = await Effect.runPromise(session.resume(created))

    expect(result).toEqual({ verdict: "pass" })
    expect(actions).toEqual(["create", "prompt"])
  })

  test("reconnects the event subscription before using the status fallback", async () => {
    let subscriptions = 0
    const adapter = makeAdapter({
      subscribeSessionEvents: () => {
        subscriptions += 1
        return subscriptions === 1
          ? Stream.fail(new OpenCodeAdapterError({ operation: "subscribe", cause: "disconnected" }))
          : Stream.fromIterable([completedAt("ses_structured")])
      },
      getSessionStatus: () => Effect.succeed({ type: "busy" as const }),
    })

    const result = await Effect.runPromise(
      new StructuredSession(adapter, request, resultSchema).run(),
    )

    expect(result).toEqual({ verdict: "pass" })
    expect(subscriptions).toBeGreaterThanOrEqual(2)
  })

  test("uses the status and message fallback when events stay unavailable", async () => {
    let messageLists = 0
    const adapter = makeAdapter({
      subscribeSessionEvents: () =>
        Stream.fail(new OpenCodeAdapterError({ operation: "subscribe", cause: "unavailable" })),
      getSessionStatus: () => Effect.succeed({ type: "idle" as const }),
      listSessionMessages: () => {
        messageLists += 1
        return Effect.succeed([
          { id: "msg_1", role: "assistant" as const, time: { created: 1, completed: 2 } },
        ])
      },
    })

    const result = await Effect.runPromise(
      new StructuredSession(adapter, request, resultSchema).run(),
    )

    expect(result).toEqual({ verdict: "pass" })
    expect(messageLists).toBe(1)
  })

  test("fails without extraction when the session goes idle without an answer", async () => {
    let extractions = 0
    const adapter = makeAdapter({
      subscribeSessionEvents: () =>
        Stream.fail(new OpenCodeAdapterError({ operation: "subscribe", cause: "unavailable" })),
      getSessionStatus: () => Effect.succeed({ type: "idle" as const }),
      listSessionMessages: () => Effect.succeed([]),
      generateStructured: () => {
        extractions += 1
        return Effect.succeed({ verdict: "pass" })
      },
    })

    const failure = await runFailure(new StructuredSession(adapter, request, resultSchema).run())
    expect(failure).toBeInstanceOf(StructuredSessionError)
    expect(failure.message).toContain("without structured output")
    expect(extractions).toBe(0)
  })

  test("fails when the session reports an execution error", async () => {
    const adapter = makeAdapter({
      subscribeSessionEvents: () =>
        Stream.fromIterable<OpenCodeSessionEvent>([
          { type: "session.error", sessionID: "ses_structured", error: { message: "boom" } },
        ]),
    })

    const failure = await runFailure(new StructuredSession(adapter, request, resultSchema).run())
    expect(failure).toBeInstanceOf(StructuredSessionError)
    expect(failure.operation).toBe("wait for structured session")
  })

  test("leaves cleanup to the caller after an idle session fails", async () => {
    let aborts = 0
    const adapter = makeAdapter({
      subscribeSessionEvents: () =>
        Stream.fail(new OpenCodeAdapterError({ operation: "subscribe", cause: "unavailable" })),
      getSessionStatus: () => Effect.succeed({ type: "idle" as const }),
      listSessionMessages: () => Effect.succeed([]),
      abortSession: () => {
        aborts += 1
        return Effect.succeed(true)
      },
    })

    await runFailure(new StructuredSession(adapter, request, resultSchema).run())
    expect(aborts).toBe(0)
  })
})

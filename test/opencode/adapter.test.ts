import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import {
  SdkOpenCodeAdapter,
  structuredExtractionPrompt,
  toWireEvent,
  type OpenCodeAssistantMessage,
  type OpenCodeSdkClient,
  type OpenCodeWireEvent,
} from "../../src/opencode/adapter"

function makeClient(overrides: Partial<OpenCodeSdkClient> = {}): OpenCodeSdkClient {
  return {
    createSession: () => Effect.succeed({ id: "ses_1" }),
    promptSession: () => Effect.void,
    subscribeEvents: () => Stream.empty,
    activeSessions: () => Effect.succeed([]),
    sessionOutcome: () => Effect.succeed({ id: "ses_1", idle: true }),
    listMessages: () => Effect.succeed([]),
    interruptSession: () => Effect.succeed(true),
    generateText: () => Effect.succeed("{}"),
    listAgents: () => Effect.succeed([]),
    listModels: () => Effect.succeed([]),
    ...overrides,
  }
}

const collectEvents = (adapter: SdkOpenCodeAdapter, directory: string) =>
  Effect.runPromise(
    Stream.runCollect(adapter.subscribeSessionEvents({ directory })).pipe(
      Effect.map((collected) => [...collected]),
    ),
  )

const completedMessage: OpenCodeAssistantMessage = {
  id: "msg_1",
  role: "assistant",
  time: { created: 1, completed: 2 },
}

describe("SdkOpenCodeAdapter.subscribeSessionEvents", () => {
  test("normalizes wire events and scopes them to the subscribed directory", async () => {
    const wire: ReadonlyArray<OpenCodeWireEvent> = [
      {
        type: "session.status",
        sessionID: "ses_1",
        directory: "/repo",
        status: { type: "busy" },
      },
      { type: "session.status", sessionID: "ses_2", directory: "/other", status: { type: "busy" } },
      { type: "session.idle", sessionID: "ses_1", directory: "/repo" },
      {
        type: "execution.failed",
        sessionID: "ses_1",
        directory: "/repo",
        error: { message: "boom" },
      },
      { type: "execution.succeeded", sessionID: "ses_1", directory: "/repo" },
    ]
    const adapter = new SdkOpenCodeAdapter(
      makeClient({
        subscribeEvents: () => Stream.fromIterable(wire),
        listMessages: () => Effect.succeed([completedMessage]),
      }),
    )

    expect(await collectEvents(adapter, "/repo")).toEqual([
      { type: "session.status", sessionID: "ses_1", status: { type: "busy" } },
      { type: "session.status", sessionID: "ses_1", status: { type: "idle" } },
      { type: "session.error", sessionID: "ses_1", error: { message: "boom" } },
      { type: "message.updated", sessionID: "ses_1", message: completedMessage },
    ])
  })

  test("falls back to an idle status when a finished session has no completed message", async () => {
    const adapter = new SdkOpenCodeAdapter(
      makeClient({
        subscribeEvents: () =>
          Stream.fromIterable<OpenCodeWireEvent>([
            { type: "execution.succeeded", sessionID: "ses_1", directory: "/repo" },
          ]),
        listMessages: () => Effect.succeed([{ role: "assistant" as const, time: { created: 1 } }]),
      }),
    )

    expect(await collectEvents(adapter, "/repo")).toEqual([
      { type: "session.status", sessionID: "ses_1", status: { type: "idle" } },
    ])
  })

  test("surfaces interruptions as session errors", async () => {
    const adapter = new SdkOpenCodeAdapter(
      makeClient({
        subscribeEvents: () =>
          Stream.fromIterable<OpenCodeWireEvent>([
            { type: "execution.interrupted", sessionID: "ses_1", directory: "/repo" },
          ]),
      }),
    )

    const events = await collectEvents(adapter, "/repo")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "session.error", sessionID: "ses_1" })
  })
})

describe("SdkOpenCodeAdapter.getSessionStatus", () => {
  test("reports busy while the session is active", async () => {
    const adapter = new SdkOpenCodeAdapter(
      makeClient({ activeSessions: () => Effect.succeed(["ses_1"]) }),
    )

    expect(
      await Effect.runPromise(adapter.getSessionStatus({ sessionID: "ses_1", directory: "/repo" })),
    ).toEqual({ type: "busy" })
  })

  test("reports idle for an inactive session that still exists", async () => {
    const adapter = new SdkOpenCodeAdapter(makeClient())

    expect(
      await Effect.runPromise(adapter.getSessionStatus({ sessionID: "ses_1", directory: "/repo" })),
    ).toEqual({ type: "idle" })
  })

  test("reports undefined for a missing session", async () => {
    const adapter = new SdkOpenCodeAdapter(
      makeClient({ sessionOutcome: () => Effect.succeed(undefined) }),
    )

    expect(
      await Effect.runPromise(adapter.getSessionStatus({ sessionID: "ses_1", directory: "/repo" })),
    ).toBeUndefined()
  })
})

describe("SdkOpenCodeAdapter.validateAvailability", () => {
  const requested = {
    agents: ["pr-reviewer", "pr-fixer"],
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  }

  test("accepts configured agents and a configured provider model", async () => {
    const adapter = new SdkOpenCodeAdapter(
      makeClient({
        listAgents: () => Effect.succeed(["pr-reviewer", "pr-fixer", "general"]),
        listModels: () => Effect.succeed([{ providerID: "anthropic", id: "claude-sonnet-4-6" }]),
      }),
    )

    await expect(
      Effect.runPromise(adapter.validateAvailability(requested)),
    ).resolves.toBeUndefined()
  })

  test("reports every unavailable configured integration", async () => {
    const adapter = new SdkOpenCodeAdapter(
      makeClient({
        listAgents: () => Effect.succeed(["pr-reviewer"]),
        listModels: () => Effect.succeed([{ providerID: "anthropic", id: "claude-haiku-4-5" }]),
      }),
    )

    const result = await Effect.runPromise(Effect.result(adapter.validateAvailability(requested)))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.failure.cause)).toContain(
        "Unavailable OpenCode integration: agent pr-fixer, model anthropic/claude-sonnet-4-6",
      )
    }
  })
})

describe("SdkOpenCodeAdapter.generateStructured", () => {
  test("sends the schema-bearing extraction prompt and parses the JSON reply", async () => {
    const prompts: Array<string> = []
    const adapter = new SdkOpenCodeAdapter(
      makeClient({
        generateText: (input) => {
          prompts.push(input.prompt)
          return Effect.succeed('```json\n{"verdict":"pass"}\n```')
        },
      }),
    )

    const output = await Effect.runPromise(
      adapter.generateStructured({
        sessionID: "ses_1",
        directory: "/repo",
        jsonSchema: { type: "object" },
      }),
    )

    expect(output).toEqual({ verdict: "pass" })
    expect(prompts).toEqual([structuredExtractionPrompt({ type: "object" })])
  })

  test("carries validation feedback into the extraction prompt only", async () => {
    const prompts: Array<string> = []
    const adapter = new SdkOpenCodeAdapter(
      makeClient({
        generateText: (input) => {
          prompts.push(input.prompt)
          return Effect.succeed("{}")
        },
      }),
    )

    await Effect.runPromise(
      adapter.generateStructured({
        sessionID: "ses_1",
        directory: "/repo",
        jsonSchema: { type: "object" },
        feedback: "verdict is required",
      }),
    )

    expect(prompts[0]).toContain("verdict is required")
  })

  test("fails when the extraction reply is not JSON", async () => {
    const adapter = new SdkOpenCodeAdapter(
      makeClient({ generateText: () => Effect.succeed("no json here") }),
    )

    const result = await Effect.runPromise(
      Effect.result(
        adapter.generateStructured({
          sessionID: "ses_1",
          directory: "/repo",
          jsonSchema: { type: "object" },
        }),
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.failure.cause)).toContain("did not return JSON")
    }
  })
})

test("SdkOpenCodeAdapter forwards session lifecycle calls through the seam", async () => {
  const calls: Array<{ readonly operation: string; readonly input: unknown }> = []
  const record = (operation: string) => (input: unknown) => {
    calls.push({ operation, input })
  }
  const adapter = new SdkOpenCodeAdapter(
    makeClient({
      createSession: (input) => {
        record("create")(input)
        return Effect.succeed({ id: "ses_1" })
      },
      promptSession: (input) => {
        record("prompt")(input)
        return Effect.void
      },
      interruptSession: (input) => {
        record("interrupt")(input)
        return Effect.succeed(true)
      },
      listMessages: (input) => {
        record("messages")(input)
        return Effect.succeed([completedMessage])
      },
    }),
  )

  const model = { providerID: "anthropic", modelID: "sonnet" }
  const created = await Effect.runPromise(
    adapter.createSession({ directory: "/repo", title: "review", agent: "reviewer", model }),
  )
  expect(created).toEqual({ id: "ses_1" })
  await Effect.runPromise(
    adapter.promptSession({
      sessionID: "ses_1",
      directory: "/repo",
      agent: "reviewer",
      model,
      text: "review",
    }),
  )
  expect(
    await Effect.runPromise(
      adapter.listSessionMessages({ sessionID: "ses_1", directory: "/repo" }),
    ),
  ).toEqual([completedMessage])
  expect(
    await Effect.runPromise(adapter.abortSession({ sessionID: "ses_1", directory: "/repo" })),
  ).toBe(true)
  expect(calls).toEqual([
    {
      operation: "create",
      input: { directory: "/repo", title: "review", agent: "reviewer", model },
    },
    {
      operation: "prompt",
      input: { sessionID: "ses_1", agent: "reviewer", model, text: "review" },
    },
    { operation: "messages", input: { sessionID: "ses_1", limit: 20 } },
    { operation: "interrupt", input: { sessionID: "ses_1" } },
  ])
})

describe("toWireEvent", () => {
  const located = { location: { directory: "/repo" } }

  test("drops events without a session id", () => {
    expect(toWireEvent({ type: "session.idle", data: {} })).toBeUndefined()
    expect(toWireEvent({ type: "session.idle", data: { sessionID: 7 } })).toBeUndefined()
  })

  test("maps session.status for known status types only", () => {
    for (const statusType of ["busy", "retry", "idle"] as const) {
      expect(
        toWireEvent({
          type: "session.status",
          data: { sessionID: "ses_1", status: { type: statusType } },
          ...located,
        }),
      ).toEqual({
        type: "session.status",
        sessionID: "ses_1",
        status: { type: statusType },
        directory: "/repo",
      })
    }
    expect(
      toWireEvent({
        type: "session.status",
        data: { sessionID: "ses_1", status: { type: "queued" } },
      }),
    ).toBeUndefined()
    expect(toWireEvent({ type: "session.status", data: { sessionID: "ses_1" } })).toBeUndefined()
  })

  test("maps idle and execution outcomes with optional location", () => {
    expect(toWireEvent({ type: "session.idle", data: { sessionID: "ses_1" } })).toEqual({
      type: "session.idle",
      sessionID: "ses_1",
    })
    expect(
      toWireEvent({
        type: "session.execution.succeeded",
        data: { sessionID: "ses_1" },
        ...located,
      }),
    ).toEqual({ type: "execution.succeeded", sessionID: "ses_1", directory: "/repo" })
    expect(
      toWireEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } }),
    ).toEqual({ type: "execution.interrupted", sessionID: "ses_1" })
  })

  test("maps execution.failed with and without an error payload", () => {
    expect(
      toWireEvent({
        type: "session.execution.failed",
        data: { sessionID: "ses_1", error: { name: "boom" } },
        ...located,
      }),
    ).toEqual({
      type: "execution.failed",
      sessionID: "ses_1",
      error: { name: "boom" },
      directory: "/repo",
    })
    expect(toWireEvent({ type: "session.execution.failed", data: { sessionID: "ses_1" } })).toEqual(
      { type: "execution.failed", sessionID: "ses_1" },
    )
  })

  test("drops unrelated event types", () => {
    expect(
      toWireEvent({ type: "session.message.content.updated", data: { sessionID: "ses_1" } }),
    ).toBeUndefined()
  })
})

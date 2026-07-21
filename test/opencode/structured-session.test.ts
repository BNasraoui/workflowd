import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { OpenCodeAdapter } from "../../src/opencode/adapter"
import { StructuredSession, StructuredSessionError } from "../../src/opencode/structured-session"

async function* events(
  ...values: ReadonlyArray<
    Awaited<ReturnType<OpenCodeAdapter["subscribeSessionEvents"]>> extends AsyncIterable<
      infer Event
    >
      ? Event
      : never
  >
) {
  yield* values
}

function makeAdapter(overrides: Partial<OpenCodeAdapter> = {}): OpenCodeAdapter {
  return {
    createSession: async () => ({ id: "ses_structured" }),
    promptSession: async () => undefined,
    subscribeSessionEvents: async () => events(),
    getSessionStatus: async () => ({ type: "busy" }),
    listSessionMessages: async () => [],
    abortSession: async () => true,
    validateAvailability: async () => undefined,
    ...overrides,
  }
}

const request = {
  directory: "/tmp/worktree",
  title: "review:owner/repo#7@abc123",
  agent: "pr-reviewer",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  format: {
    type: "json_schema" as const,
    schema: { type: "object" },
    retryCount: 2,
  },
  prompt: "Review the pull request.",
  pollIntervalMs: 0,
}

const resultSchema = Schema.Struct({ verdict: Schema.Literal("pass") })

describe("StructuredSession", () => {
  test("creates a native session without prompting until the caller resumes it", async () => {
    const actions: Array<string> = []
    const adapter = makeAdapter({
      createSession: async () => {
        actions.push("create")
        return { id: "ses_checkpointed" }
      },
      promptSession: async () => {
        actions.push("prompt")
      },
      subscribeSessionEvents: async () =>
        events({
          type: "message.updated",
          sessionID: "ses_checkpointed",
          message: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: { verdict: "pass" },
          },
        }),
    })
    const session = new StructuredSession(adapter, request, resultSchema)

    const created = await session.create()

    expect(created).toEqual({ sessionID: "ses_checkpointed", directory: "/tmp/worktree" })
    expect(actions).toEqual(["create"])

    const result = await session.resume(created)

    expect(result).toEqual({ verdict: "pass" })
    expect(actions).toEqual(["create", "prompt"])
  })

  test("reconnects the event subscription before using the status fallback", async () => {
    let subscriptions = 0
    let statusChecks = 0
    const adapter = makeAdapter({
      subscribeSessionEvents: async () => {
        subscriptions += 1
        if (subscriptions === 1) throw new Error("stream disconnected")
        return events({
          type: "message.updated",
          sessionID: "ses_structured",
          message: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: { verdict: "pass" },
          },
        })
      },
      getSessionStatus: async () => {
        statusChecks += 1
        return { type: "busy" }
      },
    })

    const result = await new StructuredSession(adapter, request, resultSchema).run()

    expect(result).toEqual({ verdict: "pass" })
    expect(subscriptions).toBe(2)
    expect(statusChecks).toBeLessThanOrEqual(1)
  })

  test("uses a scheduled status and message fallback after event errors", async () => {
    let messageLists = 0
    const adapter = makeAdapter({
      subscribeSessionEvents: async () => {
        throw new Error("events unavailable")
      },
      getSessionStatus: async () => ({ type: "idle" }),
      listSessionMessages: async () => {
        messageLists += 1
        return [
          {
            role: "assistant" as const,
            time: { created: 1, completed: 2 },
            structured: { verdict: "pass" },
          },
        ]
      },
    })

    const result = await new StructuredSession(adapter, request, resultSchema).run()

    expect(result).toEqual({ verdict: "pass" })
    expect(messageLists).toBe(1)
  })

  test("fails and aborts an idle async prompt without a terminal message", async () => {
    let aborts = 0
    const adapter = makeAdapter({
      subscribeSessionEvents: async () => {
        throw new Error("events unavailable")
      },
      getSessionStatus: async () => ({ type: "idle" }),
      abortSession: async () => {
        aborts += 1
        return true
      },
    })

    await expect(
      new StructuredSession(adapter, request, resultSchema).run(),
    ).rejects.toBeInstanceOf(StructuredSessionError)
    expect(aborts).toBe(1)
  })

  test("settles and aborts the session when the caller cancels waiting", async () => {
    const controller = new AbortController()
    const prompted = Promise.withResolvers<void>()
    let aborts = 0
    const adapter = makeAdapter({
      promptSession: async () => {
        prompted.resolve()
      },
      getSessionStatus: async () => ({ type: "busy" }),
      abortSession: async () => {
        aborts += 1
        return true
      },
    })

    const execution = new StructuredSession(adapter, request, resultSchema).run(controller.signal)
    await prompted.promise
    controller.abort(new Error("job cancelled"))

    await expect(execution).rejects.toBeInstanceOf(StructuredSessionError)
    expect(aborts).toBe(1)
  })

  test("rejects malformed structured output at the session seam", async () => {
    const adapter = makeAdapter({
      subscribeSessionEvents: async () =>
        events({
          type: "message.updated",
          sessionID: "ses_structured",
          message: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: { verdict: "unexpected" },
          },
        }),
    })

    await expect(
      new StructuredSession(adapter, request, resultSchema).run(),
    ).rejects.toBeInstanceOf(StructuredSessionError)
  })
})

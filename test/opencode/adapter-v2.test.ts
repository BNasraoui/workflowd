import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode-ai/client"
import { ClientError } from "@opencode-ai/client"
import {
  ClientOpenCodeAdapter,
  extractStructuredPayload,
  type OpenCodeV2Client,
} from "../../src/opencode/adapter-v2"

async function collect<T>(values: AsyncIterable<T>): Promise<ReadonlyArray<T>> {
  const collected: Array<T> = []
  for await (const value of values) collected.push(value)
  return collected
}

function makeClient(overrides: Partial<OpenCodeV2Client> = {}): OpenCodeV2Client {
  const sessionInfo = {
    id: "ses_v2",
    projectID: "prj",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/repo" },
  }
  return {
    session: {
      create: async () => {
        throw new Error("session.create not faked")
      },
      active: async () => ({}),
      get: async () => sessionInfo,
      prompt: async () => undefined,
      interrupt: async () => ({ interrupted: true }),
      ...overrides.session,
    },
    message: {
      list: async () => ({ data: [], cursor: {} }),
      ...overrides.message,
    },
    agent: {
      list: async () => ({
        location: {
          directory: "/repo",
          project: { id: "p", directory: "/repo", canonical: "/repo" },
        },
        data: [],
      }),
      ...overrides.agent,
    },
    model: {
      list: async () => ({
        location: {
          directory: "/repo",
          project: { id: "p", directory: "/repo", canonical: "/repo" },
        },
        data: [],
      }),
      ...overrides.model,
    },
    event: {
      subscribe: async function* () {},
      ...overrides.event,
    },
  }
}

function makeModelInfo(
  providerID: string,
  modelID: string,
): Awaited<ReturnType<OpenCodeV2Client["model"]["list"]>>["data"][number] {
  return {
    id: modelID,
    modelID,
    providerID,
    name: modelID,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 8_192 },
  }
}

const signal = new AbortController().signal

describe("ClientOpenCodeAdapter.createSession", () => {
  test("binds the directory, title, agent, and model at session creation", async () => {
    const calls: Array<{ readonly input: unknown; readonly signal: AbortSignal }> = []
    const client = makeClient({
      session: {
        ...makeClient().session,
        create: async (input, options) => {
          calls.push({ input, signal: options?.signal ?? signal })
          return {
            id: "ses_v2",
            projectID: "prj",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            location: { directory: "/repo" },
          }
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    const created = await adapter.createSession(
      {
        directory: "/repo",
        title: "review:owner/repo#7@abc",
        agent: "pr-reviewer",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      },
      signal,
    )

    expect(created).toEqual({ id: "ses_v2" })
    expect(calls).toEqual([
      {
        input: {
          title: "review:owner/repo#7@abc",
          agent: "pr-reviewer",
          model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
          location: { directory: "/repo" },
        },
        signal,
      },
    ])
  })
})

describe("ClientOpenCodeAdapter.promptSession", () => {
  test("submits the prompt with the schema requested via plain prompting", async () => {
    const calls: Array<{
      readonly input: Parameters<OpenCodeV2Client["session"]["prompt"]>[0]
      readonly signal: AbortSignal
    }> = []
    const client = makeClient({
      session: {
        ...makeClient().session,
        prompt: async (input, options) => {
          calls.push({ input, signal: options?.signal ?? signal })
          return {}
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    }

    await adapter.promptSession(
      {
        sessionID: "ses_v2",
        directory: "/repo",
        agent: "pr-reviewer",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        format: { type: "json_schema", schema, retryCount: 2 },
        parts: [{ type: "text", text: "Review the pull request." }],
      },
      signal,
    )

    expect(calls).toHaveLength(1)
    const dispatched = calls[0]!.input
    expect(dispatched.sessionID).toBe("ses_v2")
    expect(dispatched.delivery).toBe("queue")
    expect(dispatched.text.startsWith("Review the pull request.")).toBe(true)
    expect(dispatched.text).toContain(JSON.stringify(schema))
  })
})

describe("ClientOpenCodeAdapter.subscribeSessionEvents", () => {
  test("does not open the SSE subscription before iteration starts", async () => {
    let subscriptionStarted = false
    const client = makeClient({
      event: {
        subscribe: (options) => {
          void options?.signal
          subscriptionStarted = true
          return (async function* () {})()
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    const events = await adapter.subscribeSessionEvents(
      { directory: "/repo" },
      new AbortController().signal,
    )
    await events[Symbol.asyncIterator]().return?.()

    expect(subscriptionStarted).toBe(false)
  })

  test("aborts and finalizes the SSE subscription when consumption stops early", async () => {
    let subscriptionSignal: AbortSignal | undefined
    const lifecycle: Array<"abort" | "return"> = []
    const client = makeClient({
      event: {
        subscribe: (options) => {
          subscriptionSignal = options?.signal
          const resolved = options?.signal ?? new AbortController().signal
          resolved.addEventListener("abort", () => lifecycle.push("abort"))
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                if (resolved.aborted) return { done: true, value: undefined } as const
                return {
                  done: false as const,
                  value: {
                    id: "evt_1",
                    created: 1,
                    type: "session.idle",
                    data: { sessionID: "ses_v2" },
                  } satisfies OpenCodeEvent,
                }
              },
              return: async () => {
                lifecycle.push("return")
                return { done: true as const, value: undefined }
              },
            }),
          }
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)
    const caller = new AbortController()

    const events = await adapter.subscribeSessionEvents({ directory: "/repo" }, caller.signal)
    for await (const event of events) {
      expect(event).toEqual({
        type: "session.status",
        sessionID: "ses_v2",
        status: { type: "idle" },
      })
      break
    }

    expect(subscriptionSignal).not.toBe(caller.signal)
    expect(subscriptionSignal?.aborted).toBe(true)
    expect(lifecycle).toEqual(["abort", "return"])
    expect(caller.signal.aborted).toBe(false)
  })

  test("forwards caller cancellation to the SSE subscription", async () => {
    let subscriptionSignal: AbortSignal | undefined
    let markSubscriptionStarted: () => void = () => undefined
    const subscriptionStarted = new Promise<void>((resolve) => {
      markSubscriptionStarted = resolve
    })
    const client = makeClient({
      event: {
        subscribe: (options) => {
          subscriptionSignal = options?.signal
          markSubscriptionStarted()
          const resolved = options?.signal ?? new AbortController().signal
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                await new Promise<void>((resolve) => {
                  if (resolved.aborted) resolve()
                  else resolved.addEventListener("abort", () => resolve(), { once: true })
                })
                return { done: true, value: undefined } as const
              },
              return: async () => ({ done: true as const, value: undefined }),
            }),
          }
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)
    const caller = new AbortController()
    const events = await adapter.subscribeSessionEvents({ directory: "/repo" }, caller.signal)

    const completion = events[Symbol.asyncIterator]().next()
    await subscriptionStarted
    const reason = new Error("caller cancelled")
    caller.abort(reason)

    expect(await completion).toEqual({ done: true, value: undefined })
    expect(subscriptionSignal).not.toBe(caller.signal)
    expect(subscriptionSignal?.aborted).toBe(true)
    expect(subscriptionSignal?.reason).toBe(reason)
  })

  test("maps v2 events into the internal session event union", async () => {
    const events: ReadonlyArray<OpenCodeEvent> = [
      {
        id: "evt_1",
        created: 1,
        type: "session.message.content.updated",
        durable: { aggregateID: "ses_v2", seq: 1, version: 1 },
        data: {
          sessionID: "ses_v2",
          messageID: "msg_1",
          content: [{ type: "text", text: "working" }],
        },
      },
      {
        id: "evt_2",
        created: 2,
        type: "session.status",
        data: { sessionID: "ses_v2", status: { type: "busy" } },
      },
      {
        id: "evt_3",
        created: 3,
        type: "session.idle",
        data: { sessionID: "ses_v2" },
      },
      {
        id: "evt_4",
        created: 4,
        type: "session.execution.failed",
        durable: { aggregateID: "ses_v2", seq: 2, version: 1 },
        data: { sessionID: "ses_v2", error: { type: "api_error", message: "boom" } },
      },
      {
        id: "evt_5",
        created: 5,
        type: "session.renamed",
        durable: { aggregateID: "ses_v2", seq: 3, version: 1 },
        data: { sessionID: "ses_v2", title: "ignored" },
      },
    ]
    const client = makeClient({
      event: {
        subscribe: async function* () {
          yield* events
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    expect(
      await collect(await adapter.subscribeSessionEvents({ directory: "/repo" }, signal)),
    ).toEqual([
      {
        type: "message.updated",
        sessionID: "ses_v2",
        message: { id: "msg_1", role: "assistant", time: { created: 1 } },
      },
      { type: "session.status", sessionID: "ses_v2", status: { type: "busy" } },
      { type: "session.status", sessionID: "ses_v2", status: { type: "idle" } },
      {
        type: "session.error",
        sessionID: "ses_v2",
        error: { type: "api_error", message: "boom" },
      },
    ])
  })

  test("maps the v2-line dev-build session.next.* encoding", async () => {
    // Observed on opencode 0.0.0-dev-202608300437: these event names are not
    // in the published client types yet.
    const events: ReadonlyArray<unknown> = [
      {
        id: "evt_d1",
        type: "session.next.prompt.admitted",
        data: { sessionID: "ses_v2", messageID: "msg_u", prompt: { text: "hi" } },
      },
      {
        id: "evt_d2",
        type: "session.next.step.started",
        data: { sessionID: "ses_v2", assistantMessageID: "msg_a" },
      },
      {
        id: "evt_d3",
        type: "session.next.text.ended",
        data: { sessionID: "ses_v2", assistantMessageID: "msg_a", text: '{"verdict":"pass"}' },
      },
      {
        id: "evt_d4",
        type: "session.next.step.ended",
        data: { sessionID: "ses_v2", assistantMessageID: "msg_a" },
      },
      {
        id: "evt_d5",
        type: "session.next.step.failed",
        data: {
          sessionID: "ses_v2",
          assistantMessageID: "msg_a",
          error: { type: "unknown", message: "Provider request failed with HTTP 503" },
        },
      },
    ]
    const client = makeClient({
      event: {
        subscribe: async function* () {
          yield* events
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    expect(
      await collect(await adapter.subscribeSessionEvents({ directory: "/repo" }, signal)),
    ).toEqual([
      { type: "session.status", sessionID: "ses_v2", status: { type: "busy" } },
      {
        type: "message.updated",
        sessionID: "ses_v2",
        message: {
          id: "msg_a",
          role: "assistant",
          time: { created: 0, completed: 0 },
          structured: { verdict: "pass" },
        },
      },
      { type: "session.status", sessionID: "ses_v2", status: { type: "idle" } },
      {
        type: "session.error",
        sessionID: "ses_v2",
        error: { type: "unknown", message: "Provider request failed with HTTP 503" },
      },
    ])
  })
})

describe("ClientOpenCodeAdapter.getSessionStatus", () => {
  test("maps active sessions to busy and everything else to idle", async () => {
    const client = makeClient({
      session: {
        ...makeClient().session,
        active: async () => ({ ses_running: { type: "running" } }),
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    expect(
      await adapter.getSessionStatus({ sessionID: "ses_running", directory: "/repo" }, signal),
    ).toEqual({ type: "busy" })
    expect(
      await adapter.getSessionStatus({ sessionID: "ses_finished", directory: "/repo" }, signal),
    ).toEqual({ type: "idle" })
  })
})

describe("ClientOpenCodeAdapter.sessionExists", () => {
  test("reports existing sessions and maps SessionNotFoundError to false", async () => {
    const adapter = new ClientOpenCodeAdapter(makeClient())
    expect(await adapter.sessionExists({ sessionID: "ses_v2", directory: "/repo" }, signal)).toBe(
      true,
    )

    const missing = new ClientOpenCodeAdapter(
      makeClient({
        session: {
          ...makeClient().session,
          get: async () => {
            // The v2 client rethrows decoded error bodies such as
            // {_tag: "SessionNotFoundError", ...}; attach the tag to an Error
            // to reproduce that wire behavior.
            throw Object.assign(new Error("nope"), {
              _tag: "SessionNotFoundError",
              sessionID: "ses_gone",
            })
          },
        },
      }),
    )
    expect(await missing.sessionExists({ sessionID: "ses_gone", directory: "/repo" }, signal)).toBe(
      false,
    )
  })

  test("surfaces unexpected HTTP statuses with the status code", async () => {
    const cause = { status: 401 }
    const error = new ClientError("UnexpectedStatus", { cause })
    const adapter = new ClientOpenCodeAdapter(
      makeClient({
        session: {
          ...makeClient().session,
          get: async () => {
            throw error
          },
        },
      }),
    )

    await expect(
      adapter.sessionExists({ sessionID: "ses_v2", directory: "/repo" }, signal),
    ).rejects.toThrow("OpenCode session probe failed with HTTP 401")
  })
})

describe("ClientOpenCodeAdapter.listSessionMessages", () => {
  test("keeps assistant messages, requests a bounded page, and recovers the JSON payload", async () => {
    const calls: Array<unknown> = []
    const client = makeClient({
      message: {
        list: async (input) => {
          calls.push(input)
          return {
            data: [
              {
                id: "msg_user",
                time: { created: 1 },
                type: "user" as const,
                text: "hello",
              },
              {
                id: "msg_assistant",
                time: { created: 2, completed: 3 },
                type: "assistant" as const,
                agent: "pr-reviewer",
                model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
                content: [
                  { type: "text" as const, text: "Here is the result:" },
                  { type: "text" as const, text: '{"verdict":"pass"}' },
                ],
              },
            ],
            cursor: {},
          }
        },
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    expect(
      await adapter.listSessionMessages({ sessionID: "ses_v2", directory: "/repo" }, signal),
    ).toEqual([
      {
        id: "msg_assistant",
        role: "assistant",
        time: { created: 2, completed: 3 },
        structured: { verdict: "pass" },
      },
    ])
    expect(calls).toEqual([{ sessionID: "ses_v2", limit: 20 }])
  })

  test("keeps message errors instead of parsing text", async () => {
    const client = makeClient({
      message: {
        list: async () => ({
          data: [
            {
              id: "msg_assistant",
              time: { created: 2, completed: 3 },
              type: "assistant" as const,
              agent: "pr-reviewer",
              model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
              content: [{ type: "text" as const, text: "not json" }],
              error: { type: "api_error", message: "provider exploded" },
            },
          ],
          cursor: {},
        }),
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    expect(
      await adapter.listSessionMessages({ sessionID: "ses_v2", directory: "/repo" }, signal),
    ).toEqual([
      {
        id: "msg_assistant",
        role: "assistant",
        time: { created: 2, completed: 3 },
        error: { type: "api_error", message: "provider exploded" },
      },
    ])
  })
})

describe("ClientOpenCodeAdapter.abortSession", () => {
  test("returns the interrupt confirmation", async () => {
    const adapter = new ClientOpenCodeAdapter(makeClient())
    expect(await adapter.abortSession({ sessionID: "ses_v2", directory: "/repo" }, signal)).toBe(
      true,
    )
  })
})

describe("ClientOpenCodeAdapter.validateAvailability", () => {
  test("groups the v2 model list into provider availability", async () => {
    const client = makeClient({
      agent: {
        list: async () => ({
          location: {
            directory: "/repo",
            project: { id: "p", directory: "/repo", canonical: "/repo" },
          },
          data: [
            {
              id: "pr-reviewer",
              name: "pr-reviewer",
              mode: "all",
              hidden: false,
              permissions: [],
              request: { settings: {}, headers: {}, body: {} },
            },
          ] as Awaited<ReturnType<OpenCodeV2Client["agent"]["list"]>>["data"],
        }),
      },
      model: {
        list: async () => ({
          location: {
            directory: "/repo",
            project: { id: "p", directory: "/repo", canonical: "/repo" },
          },
          data: [
            makeModelInfo("anthropic", "claude-sonnet-4-6"),
            makeModelInfo("anthropic", "claude-haiku-4-5"),
          ],
        }),
      },
    })
    const adapter = new ClientOpenCodeAdapter(client)

    await expect(
      adapter.validateAvailability(
        {
          directory: "/repo",
          agents: ["pr-reviewer"],
          model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
        },
        signal,
      ),
    ).resolves.toBeUndefined()

    await expect(
      adapter.validateAvailability(
        {
          directory: "/repo",
          agents: ["pr-fixer"],
          model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        },
        signal,
      ),
    ).rejects.toThrow("Unavailable OpenCode integration: agent pr-fixer, model openai/gpt-5.6-sol")
  })
})

describe("extractStructuredPayload", () => {
  test("parses plain, fenced, and prose-wrapped JSON payloads", () => {
    expect(extractStructuredPayload('{"verdict":"pass"}')).toEqual({ verdict: "pass" })
    expect(extractStructuredPayload('```json\n{"verdict":"pass"}\n```')).toEqual({
      verdict: "pass",
    })
    expect(extractStructuredPayload('The result is: {"verdict":"pass"}')).toEqual({
      verdict: "pass",
    })
    expect(extractStructuredPayload("[1,2,3]")).toEqual([1, 2, 3])
  })

  test("returns undefined for non-JSON output", () => {
    expect(extractStructuredPayload("plain prose without any payload")).toBeUndefined()
    expect(extractStructuredPayload('{"verdict": truncated')).toBeUndefined()
  })
})

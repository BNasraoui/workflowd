import { describe, expect, test } from "bun:test"
import {
  makeOpenCodeSdkClient,
  SdkOpenCodeAdapter,
  type OpenCodeSdkClient,
} from "../../src/opencode/adapter"
import type { AssistantMessage, Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"

async function collect<T>(values: AsyncIterable<T>): Promise<ReadonlyArray<T>> {
  const collected: Array<T> = []
  for await (const value of values) collected.push(value)
  return collected
}

function availabilityAdapter(
  agents: ReadonlyArray<string>,
  models: ReadonlyArray<string>,
) {
  const client = {
    createSession: async () => ({ id: "unused" }),
    promptSession: async () => undefined,
    subscribeEvents: async () => (async function* () {})(),
    getSessionStatuses: async () => ({}),
    listSessionMessages: async () => [],
    abortSession: async () => true,
    listAgents: async () => agents,
    listProviders: async () => [
      { id: "anthropic", modelIDs: models },
    ],
  } satisfies OpenCodeSdkClient
  return new SdkOpenCodeAdapter(client)
}

const requested = {
  agents: ["pr-reviewer", "pr-fixer"],
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
}

describe("OpenCodeAdapter.validateAvailability", () => {
  test("accepts configured agents and a configured provider model", async () => {
    const adapter = availabilityAdapter(
      ["pr-reviewer", "pr-fixer", "general"],
      ["claude-sonnet-4-6"],
    )

    await expect(
      adapter.validateAvailability(requested, new AbortController().signal),
    ).resolves.toBeUndefined()
  })

  test("reports every unavailable configured integration", async () => {
    const adapter = availabilityAdapter(
      ["pr-reviewer"],
      ["claude-haiku-4-5"],
    )

    await expect(
      adapter.validateAvailability(requested, new AbortController().signal),
    ).rejects.toThrow(
      "Unavailable OpenCode integration: agent pr-fixer, model anthropic/claude-sonnet-4-6",
    )
  })
})

test("SdkOpenCodeAdapter normalizes assistant messages and session events", async () => {
  const assistant = {
    role: "assistant",
    time: { created: 1, completed: 2 },
    structured: { verdict: "pass" },
  } as AssistantMessage
  const client = {
    createSession: async () => ({ id: "unused" }),
    promptSession: async () => undefined,
    subscribeEvents: async () =>
      (async function* () {
        yield { type: "message.updated", properties: { sessionID: "ses_1", info: assistant } }
        yield {
          type: "message.updated",
          properties: { sessionID: "ses_1", info: { role: "user" } },
        }
        yield {
          type: "session.status",
          properties: { sessionID: "ses_1", status: { type: "busy" } },
        }
        yield { type: "session.idle", properties: { sessionID: "ses_1" } }
        yield { type: "session.error", properties: { sessionID: "ses_1" } }
      })() as AsyncIterable<Event>,
    getSessionStatuses: async () => ({ ses_1: { type: "busy" } }),
    listSessionMessages: async () => [assistant],
    abortSession: async () => true,
    listAgents: async () => [],
    listProviders: async () => [],
  } satisfies OpenCodeSdkClient
  const adapter = new SdkOpenCodeAdapter(client)
  const signal = new AbortController().signal

  expect(await adapter.getSessionStatus({ sessionID: "ses_1", directory: "/repo" }, signal)).toEqual({ type: "busy" })
  expect(await adapter.listSessionMessages({ sessionID: "ses_1", directory: "/repo" }, signal)).toEqual([
    { role: "assistant", time: { created: 1, completed: 2 }, structured: { verdict: "pass" } },
  ])
  expect(await collect(await adapter.subscribeSessionEvents({ directory: "/repo" }, signal))).toEqual([
    {
      type: "message.updated",
      sessionID: "ses_1",
      message: { role: "assistant", time: { created: 1, completed: 2 }, structured: { verdict: "pass" } },
    },
    { type: "session.status", sessionID: "ses_1", status: { type: "busy" } },
    { type: "session.status", sessionID: "ses_1", status: { type: "idle" } },
    { type: "session.error", sessionID: "ses_1" },
  ])
})

test("makeOpenCodeSdkClient unwraps SDK responses and filters messages", async () => {
  const calls: Array<{ readonly operation: string; readonly input: object; readonly options: object }> = []
  const assistant = { role: "assistant", time: { created: 1 } } as AssistantMessage
  const fake = Object.assign(Object.create(null) as OpencodeClient, {
    session: {
      create: async (input: object, options: object) => {
        calls.push({ operation: "create", input, options })
        return { data: { id: "ses_1" } }
      },
      promptAsync: async (input: object, options: object) => {
        calls.push({ operation: "prompt", input, options })
        return { data: true }
      },
      status: async (input: object, options: object) => {
        calls.push({ operation: "status", input, options })
        return { data: { ses_1: { type: "idle" } } }
      },
      messages: async (input: object, options: object) => {
        calls.push({ operation: "messages", input, options })
        return { data: [{ info: { role: "user" } }, { info: assistant }] }
      },
      abort: async (input: object, options: object) => {
        calls.push({ operation: "abort", input, options })
        return { data: true }
      },
    },
    event: {
      subscribe: async (input: object, options: object) => {
        calls.push({ operation: "subscribe", input, options })
        return { stream: (async function* () {})() }
      },
    },
    app: {
      agents: async (input: object, options: object) => {
        calls.push({ operation: "agents", input, options })
        return { data: [{ name: "reviewer" }] }
      },
    },
    config: {
      providers: async (input: object, options: object) => {
        calls.push({ operation: "providers", input, options })
        return { data: { providers: [{ id: "anthropic", models: { sonnet: {}, haiku: {} } }] } }
      },
    },
  })
  const client = makeOpenCodeSdkClient(fake)
  const signal = new AbortController().signal

  expect(await client.createSession({ directory: "/repo", title: "review" }, signal)).toEqual({ id: "ses_1" })
  await client.promptSession({
    sessionID: "ses_1",
    directory: "/repo",
    agent: "reviewer",
    model: { providerID: "anthropic", modelID: "sonnet" },
    format: { type: "json_schema", schema: { type: "object" }, retryCount: 2 },
    parts: [{ type: "text", text: "review" }],
  }, signal)
  await client.subscribeEvents({ directory: "/repo" }, signal)
  expect(await client.getSessionStatuses({ directory: "/repo" }, signal)).toEqual({ ses_1: { type: "idle" } })
  expect(await client.listSessionMessages({ sessionID: "ses_1", directory: "/repo" }, signal)).toEqual([assistant])
  expect(await client.abortSession({ sessionID: "ses_1", directory: "/repo" }, signal)).toBe(true)
  expect(await client.listAgents({ directory: "/repo" }, signal)).toEqual(["reviewer"])
  expect(await client.listProviders({ directory: "/repo" }, signal)).toEqual([
    { id: "anthropic", modelIDs: ["sonnet", "haiku"] },
  ])
  expect(calls.map(({ operation }) => operation)).toEqual([
    "create", "prompt", "subscribe", "status", "messages", "abort", "agents", "providers",
  ])
  expect(calls.find(({ operation }) => operation === "messages")?.input).toEqual({
    sessionID: "ses_1",
    directory: "/repo",
    limit: 20,
  })
  expect(calls.find(({ operation }) => operation === "subscribe")?.options).toMatchObject({
    signal,
    throwOnError: true,
    sseMaxRetryAttempts: 3,
  })
})

import { describe, expect, test } from "bun:test"
import { SdkOpenCodeAdapter, type OpenCodeSdkClient } from "../../src/opencode/adapter"
import type { AssistantMessage, Event } from "@opencode-ai/sdk/v2/client"

async function collect<T>(values: AsyncIterable<T>): Promise<ReadonlyArray<T>> {
  const collected: Array<T> = []
  for await (const value of values) collected.push(value)
  return collected
}

function availabilityAdapter(agents: ReadonlyArray<string>, models: ReadonlyArray<string>) {
  const client = {
    createSession: async () => ({ id: "unused" }),
    promptSession: async () => undefined,
    subscribeEvents: async () => (async function* () {})(),
    getSessionStatuses: async () => ({}),
    listSessionMessages: async () => [],
    abortSession: async () => true,
    listAgents: async () => agents,
    listProviders: async () => [{ id: "anthropic", modelIDs: models }],
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
    const adapter = availabilityAdapter(["pr-reviewer"], ["claude-haiku-4-5"])

    await expect(
      adapter.validateAvailability(requested, new AbortController().signal),
    ).rejects.toThrow(
      "Unavailable OpenCode integration: agent pr-fixer, model anthropic/claude-sonnet-4-6",
    )
  })
})

test("SdkOpenCodeAdapter normalizes assistant messages and session events", async () => {
  const assistant = {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "msg_0",
    modelID: "sonnet",
    providerID: "anthropic",
    mode: "review",
    agent: "reviewer",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    structured: { verdict: "pass" },
  } satisfies AssistantMessage
  const events = [
    {
      id: "evt_1",
      type: "message.updated",
      properties: { sessionID: "ses_1", info: assistant },
    },
    {
      id: "evt_2",
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    },
    { id: "evt_3", type: "session.idle", properties: { sessionID: "ses_1" } },
    { id: "evt_4", type: "session.error", properties: { sessionID: "ses_1" } },
  ] satisfies ReadonlyArray<Event>
  const calls: Array<{
    readonly operation: string
    readonly input: object
    readonly signal: AbortSignal
  }> = []
  const record = (operation: string, input: object, signal: AbortSignal) => {
    calls.push({ operation, input, signal })
  }
  const client = {
    createSession: async (input, signal) => {
      record("create", input, signal)
      return { id: "ses_1" }
    },
    promptSession: async (input, signal) => {
      record("prompt", input, signal)
    },
    subscribeEvents: async (input, signal) => {
      record("subscribe", input, signal)
      return (async function* () {
        yield* events
      })()
    },
    getSessionStatuses: async (input, signal) => {
      record("status", input, signal)
      return { ses_1: { type: "busy" as const } }
    },
    listSessionMessages: async (input, signal) => {
      record("messages", input, signal)
      return [assistant]
    },
    abortSession: async (input, signal) => {
      record("abort", input, signal)
      return true
    },
    listAgents: async () => [],
    listProviders: async () => [],
  } satisfies OpenCodeSdkClient
  const adapter = new SdkOpenCodeAdapter(client)
  const signal = new AbortController().signal

  const createInput = { directory: "/repo", title: "review" }
  const promptInput = {
    sessionID: "ses_1",
    directory: "/repo",
    agent: "reviewer",
    model: { providerID: "anthropic", modelID: "sonnet" },
    format: { type: "json_schema" as const, schema: { type: "object" }, retryCount: 2 },
    parts: [{ type: "text" as const, text: "review" }],
  }
  const sessionInput = { sessionID: "ses_1", directory: "/repo" }

  expect(await adapter.createSession(createInput, signal)).toEqual({ id: "ses_1" })
  await adapter.promptSession(promptInput, signal)
  expect(await adapter.getSessionStatus(sessionInput, signal)).toEqual({ type: "busy" })
  expect(await adapter.listSessionMessages(sessionInput, signal)).toEqual([
    { role: "assistant", time: { created: 1, completed: 2 }, structured: { verdict: "pass" } },
  ])
  expect(
    await collect(await adapter.subscribeSessionEvents({ directory: "/repo" }, signal)),
  ).toEqual([
    {
      type: "message.updated",
      sessionID: "ses_1",
      message: {
        role: "assistant",
        time: { created: 1, completed: 2 },
        structured: { verdict: "pass" },
      },
    },
    { type: "session.status", sessionID: "ses_1", status: { type: "busy" } },
    { type: "session.status", sessionID: "ses_1", status: { type: "idle" } },
    { type: "session.error", sessionID: "ses_1" },
  ])
  expect(await adapter.abortSession(sessionInput, signal)).toBe(true)
  expect(calls).toEqual([
    { operation: "create", input: createInput, signal },
    { operation: "prompt", input: promptInput, signal },
    { operation: "status", input: { directory: "/repo" }, signal },
    { operation: "messages", input: sessionInput, signal },
    { operation: "subscribe", input: { directory: "/repo" }, signal },
    { operation: "abort", input: sessionInput, signal },
  ])
})

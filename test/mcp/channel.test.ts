import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"
import { DEFAULT_CHANNEL_MCP_URL, loadChannelOptions } from "../../src/mcp-channel"
import { CHANNEL_NOTIFICATION, createChannelMcp } from "../../src/mcp/channel"
import { TOOL_DEFINITIONS } from "../../src/mcp/tool-definitions"

type Call = { name: string; arguments: Record<string, unknown>; authorization: string | null }
type Reply = Response | { structuredContent?: Record<string, unknown>; isError?: boolean }

const terminal = {
  run_id: "agent-run-1",
  session_id: "session-1",
  native_session_id: "ses_child",
  route: "implement",
  model: "glm-5.3-flash",
  executor: "opencode",
  status: "completed",
  end_reason: "completed",
  ended_at: "2026-10-04T10:00:00.000Z",
  final_message: "done",
  final_message_ref: null,
}

const receipt = (mailbox: string) => ({
  run_id: "agent-run-1",
  mailbox_id: mailbox,
  mailbox_tool: "read_agent_mailbox",
  status: "dispatched",
  wait: null,
})

const RpcCall = Schema.Struct({
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
})
const TextContent = Schema.Array(Schema.Struct({ text: Schema.String }))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fake HTTP MCP server answering tools/call from a per-tool script. */
const fakeHttpMcp = (script: (call: Call) => Reply) => {
  const calls: Call[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = Schema.decodeUnknownSync(RpcCall)(await request.json())
      const call = { ...body.params, authorization: request.headers.get("authorization") }
      calls.push(call)
      const reply = script(call)
      if (reply instanceof Response) return reply
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: `${call.name} reply` }],
          ...reply,
        },
      })
    },
  })
  cleanups.push(() => server.stop(true))
  return { calls, url: `http://127.0.0.1:${server.port}/mcp` }
}

const connect = async (url: string, pollIntervalMs = 5) => {
  const channel = createChannelMcp({ mcpUrl: url, token: "secret", pollIntervalMs })
  const client = new Client({ name: "test", version: "1" })
  const events: Array<{ method: string; params?: Record<string, unknown> | undefined }> = []
  client.fallbackNotificationHandler = async (notification) => {
    events.push({ method: notification.method, params: notification.params })
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await channel.server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => {
    await client.close()
    await channel.close()
  })
  return { client, events, capabilities: client.getServerCapabilities() }
}

const ticks = (count: number) => Bun.sleep(count * 5 + 20)

test("declares the claude/channel capability and serves the shared tool list", async () => {
  const http = fakeHttpMcp(() => ({}))
  const { client, capabilities } = await connect(http.url)
  expect(capabilities?.experimental).toEqual({ "claude/channel": {} })
  // Raw request: the shared dispatch_agent outputSchema is an anyOf, which the SDK's own
  // listTools() schema rejects; Claude Code accepts it from the HTTP server today.
  const list = await client.request({ method: "tools/list" }, ResultSchema)
  expect(list.tools).toEqual(TOOL_DEFINITIONS.map((tool) => ({ ...tool })))
  expect(http.calls).toEqual([])
})

test("refuses parent_* and resume_prompt in-band without forwarding", async () => {
  const http = fakeHttpMcp(() => ({ structuredContent: receipt("mailbox-a") }))
  const { client } = await connect(http.url)
  for (const field of ["parent_session_id", "parent_kind", "resume_prompt"]) {
    const result = await client.callTool({
      name: "dispatch_agent",
      arguments: { route: "implement", repository: "workflowd", prompt: "go", [field]: "x" },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      reason: "live_session_parent",
    })
  }
  expect(http.calls).toEqual([])
})

test("forwards other tools with the bearer and passes their results through", async () => {
  const http = fakeHttpMcp(() => ({ structuredContent: { job_id: "j" }, isError: false }))
  const { client } = await connect(http.url)
  const result = await client.callTool({ name: "job_status", arguments: { job_id: "j" } })
  expect(result.structuredContent).toEqual({ job_id: "j" })
  expect(http.calls).toEqual([
    { name: "job_status", arguments: { job_id: "j" }, authorization: "Bearer secret" },
  ])
})

test("dispatch receipt tells the session to end its turn and emits exactly one event", async () => {
  let reads = 0
  const http = fakeHttpMcp((call) => {
    if (call.name === "dispatch_agent") return { structuredContent: receipt("mailbox-a") }
    reads += 1
    return {
      structuredContent: { mailbox_id: "mailbox-a", messages: reads < 3 ? [] : [terminal] },
    }
  })
  const { client, events } = await connect(http.url)
  const args = { route: "implement", repository: "workflowd", prompt: "go" }
  const result = await client.callTool({ name: "dispatch_agent", arguments: args })
  const text = Schema.decodeUnknownSync(TextContent)(result.content).map((part) => part.text)
  expect(text.at(-1)).toContain("the result arrives as a channel event; end your turn")
  await client.callTool({ name: "dispatch_agent", arguments: args })
  await ticks(10)
  expect(events).toEqual([
    {
      method: CHANNEL_NOTIFICATION,
      params: {
        content: JSON.stringify(Object.fromEntries(Object.entries(terminal).sort())),
        meta: { run_id: "agent-run-1", mailbox_id: "mailbox-a", status: "completed" },
      },
    },
  ])
  const readsAfterEmit = reads
  await client.callTool({ name: "dispatch_agent", arguments: args })
  await ticks(5)
  expect(events).toHaveLength(1)
  expect(reads).toBe(readsAfterEmit)
})

test("refused or failed dispatches register no watch", async () => {
  const http = fakeHttpMcp(() => ({
    structuredContent: { status: "refused", reason: "dead_route" },
    isError: true,
  }))
  const { client, events } = await connect(http.url)
  const result = await client.callTool({
    name: "dispatch_agent",
    arguments: { route: "implement", repository: "workflowd", prompt: "go" },
  })
  expect(result.isError).toBe(true)
  await ticks(5)
  expect(http.calls.map((call) => call.name)).toEqual(["dispatch_agent"])
  expect(events).toEqual([])
})

test("poll errors keep the watch and the next tick retries", async () => {
  let reads = 0
  const http = fakeHttpMcp((call) => {
    if (call.name === "dispatch_agent") return { structuredContent: receipt("mailbox-b") }
    reads += 1
    if (reads === 1) return new Response("unavailable", { status: 503 })
    if (reads === 2) return { isError: true }
    if (reads === 3) return new Response("not json")
    if (reads === 4) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1 } })
    return { structuredContent: { mailbox_id: "mailbox-b", messages: [{ ...terminal }] } }
  })
  const { client, events } = await connect(http.url)
  await client.callTool({
    name: "dispatch_agent",
    arguments: { route: "implement", repository: "workflowd", prompt: "go" },
  })
  await ticks(20)
  expect(reads).toBeGreaterThanOrEqual(5)
  expect(events).toHaveLength(1)
  expect(events[0]?.params?.meta).toEqual({
    run_id: "agent-run-1",
    mailbox_id: "mailbox-b",
    status: "completed",
  })
})

test("an unreachable HTTP server is an in-band tool error", async () => {
  const { client } = await connect("http://127.0.0.1:1/mcp")
  const result = await client.callTool({ name: "job_status", arguments: { job_id: "j" } })
  expect(result.isError).toBe(true)
})

test("channel configuration requires a bearer and validates the poll interval", async () => {
  await expect(loadChannelOptions({})).rejects.toThrow("exactly one")
  await expect(
    loadChannelOptions({ WORKFLOWD_MCP_TOKEN: "a", WORKFLOWD_MCP_TOKEN_FILE: "/f" }),
  ).rejects.toThrow()
  expect(await loadChannelOptions({ WORKFLOWD_MCP_TOKEN: "a" })).toEqual({
    mcpUrl: DEFAULT_CHANNEL_MCP_URL,
    token: "a",
    pollIntervalMs: 10_000,
  })
  expect(
    await loadChannelOptions({
      WORKFLOWD_MCP_TOKEN: "a",
      WORKFLOWD_MCP_URL: "http://127.0.0.1:9/mcp",
      WORKFLOWD_CHANNEL_POLL_MS: "250",
    }),
  ).toMatchObject({ mcpUrl: "http://127.0.0.1:9/mcp", pollIntervalMs: 250 })
  await expect(
    loadChannelOptions({ WORKFLOWD_MCP_TOKEN: "a", WORKFLOWD_CHANNEL_POLL_MS: "0" }),
  ).rejects.toThrow("positive integer")
})

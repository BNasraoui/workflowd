import { expect, test } from "bun:test"
import { subscribeToEvent } from "../../src/resident/subscribe"

test("subscription tool binds the subscriber to the run environment and rejects session spoofing", async () => {
  const sent: unknown[] = []
  const request = async (_socket: string, path: string, body?: string) => {
    sent.push({ path, body: JSON.parse(body!) })
    return Response.json({ id: "subscription", status: "registered" }, { status: 202 })
  }
  const env = { WORKFLOWD_CODEX_RESIDENT_SOCKET: "/scratch/owned.sock", WORKFLOWD_RUN_ID: "caller" }
  const selector = { kind: "agent_run", run_id: "child" }
  expect(await subscribeToEvent(selector, env, request)).toMatchObject({ status: "registered" })
  expect(sent).toEqual([{ path: "/subscriptions", body: { runId: "caller", selector } }])
  await expect(
    subscribeToEvent({ ...selector, threadId: "victim" }, env, request),
  ).rejects.toThrow()
  await expect(subscribeToEvent(selector, {}, request)).rejects.toThrow()
  expect(sent).toHaveLength(1)
})

test("MCP exposes subscribe_to_event and fails closed without a run identity", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
  const { createSubscriptionMcp } = await import("../../src/resident/mcp")
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createSubscriptionMcp({})
  const client = new Client({ name: "test", version: "1" })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const list = await client.listTools()
    expect(list.tools.map((tool) => tool.name)).toEqual(["subscribe_to_event"])
    expect(
      (
        await client.callTool({
          name: "subscribe_to_event",
          arguments: { kind: "agent_run", run_id: "child" },
        })
      ).isError,
    ).toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})

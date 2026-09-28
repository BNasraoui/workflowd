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

test("stdio MCP registers through its owned socket and returns the durable receipt", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
  const { serveRunSocket } = await import("../../src/worker-identity/peer")
  const directory = await mkdtemp(join(tmpdir(), "workflowd-subscribe-mcp-"))
  const socket = join(directory, "subscribe.sock")
  const requests: unknown[] = []
  const server = await serveRunSocket(socket, async (request, pid) => {
    expect(pid).not.toBe(process.pid)
    requests.push(await request.json())
    return Response.json(
      {
        id: "subscription-1",
        status: "registered",
        deliveryState: "pending",
        instruction: "End this turn",
      },
      { status: 202 },
    )
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../../src/resident/mcp.ts")],
    env: {
      WORKFLOWD_CODEX_RESIDENT_SOCKET: socket,
      WORKFLOWD_RUN_ID: "caller",
      CODEX_HOME: directory,
    },
  })
  const client = new Client({ name: "test", version: "1" })
  try {
    await client.connect(transport)
    const result = await client.callTool({
      name: "subscribe_to_event",
      arguments: { kind: "ci", repository: "o/r", sha: "a".repeat(40) },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      id: "subscription-1",
      status: "registered",
      deliveryState: "pending",
    })
    expect(requests).toEqual([
      { runId: "caller", selector: { kind: "ci", repository: "o/r", sha: "a".repeat(40) } },
    ])
  } finally {
    await client.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("subscribe.ts exits after registration while the event is still pending", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const { serveRunSocket } = await import("../../src/worker-identity/peer")
  const directory = await mkdtemp(join(tmpdir(), "workflowd-subscribe-cli-"))
  const socket = join(directory, "subscribe.sock")
  const requests: unknown[] = []
  const receipt = {
    id: "subscription-1",
    status: "registered",
    deliveryState: "pending",
    instruction: "End this turn",
  }
  const server = await serveRunSocket(socket, async (request) => {
    requests.push({ path: new URL(request.url).pathname, body: await request.json() })
    return Response.json(receipt, { status: 202 })
  })
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../src/resident/subscribe.ts"),
      "--agent-run",
      "never-final",
    ],
    {
      env: {
        WORKFLOWD_CODEX_RESIDENT_SOCKET: socket,
        WORKFLOWD_RUN_ID: "caller",
        CODEX_HOME: directory,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("subscribe.ts did not exit after registration")),
          3000,
        )
      }),
    ])
    expect(exitCode).toBe(0)
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual(receipt)
    expect(await new Response(child.stderr).text()).toBe("")
    expect(requests).toEqual([
      {
        path: "/subscriptions",
        body: { runId: "caller", selector: { kind: "agent_run", run_id: "never-final" } },
      },
    ])
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
    await child.exited
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { callTool } from "../../src/mcp/tools"
import { createMcpFetchHandler } from "../../src/mcp/server"
import { McpQueriesLive } from "../../src/mcp/queries"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { kernelLayer } from "../kernel/job-store-harness"
import { startDirectoryDaemon } from "./harness"

test("MCP advertises authenticated inventory and runner lookup with schema-checked daemon responses", async () => {
  const daemon = await startDirectoryDaemon("host-a", ":memory:")
  const layer = Layer.merge(McpQueriesLive, RemoteProbeProducerLive).pipe(
    Layer.provide(kernelLayer(":memory:")),
  )
  const handler = createMcpFetchHandler({
    auth: { mode: "enabled", token: "mcp-secret" },
    executionCapabilitiesDaemon: { baseUrl: daemon.url.toString(), token: "directory-secret" },
    runTool: (name, args, context) =>
      Effect.runPromise(callTool(name, args, context).pipe(Effect.provide(layer))),
  })
  const call = (args: unknown, token = "mcp-secret") =>
    handler(
      new Request("http://mcp/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "agent_directory", arguments: args },
        }),
      }),
    ).then((response) => response.json())
  try {
    expect(await call({})).toMatchObject({
      result: {
        structuredContent: {
          agents: [],
          runners: [{ hostId: "host-a", runnerId: "runner:host-a" }],
        },
      },
    })
    expect(await call({ kind: "runners", id: "runner:host-a" })).toMatchObject({
      result: { structuredContent: { agents: [], runners: [{ hostId: "host-a" }] } },
    })
    expect(await call({}, "wrong")).toMatchObject({ result: { isError: true } })
    expect(await call({ kind: "agents", id: "missing" })).toMatchObject({
      result: { isError: true },
    })
    expect(await call({ secret: "forged" })).toMatchObject({ result: { isError: true } })
    const failed = await Effect.runPromise(
      callTool(
        "agent_directory",
        {},
        {
          writesAuthorized: true,
          writesConfigured: true,
          now: () => new Date(),
          executionCapabilitiesDaemon: {
            baseUrl: "http://fixture",
            token: "private-secret",
            send: async () => Response.json({ agents: [{ cleanup: true }], runners: [] }),
          },
        },
      ).pipe(Effect.provide(layer)),
    )
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toBeUndefined()
    expect(JSON.stringify(failed)).not.toContain("private-secret")
  } finally {
    await daemon.stop()
  }
})

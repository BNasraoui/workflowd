import { expect, test } from "bun:test"
import { Effect } from "effect"
import { startMcpServer } from "../../src/mcp-server"
import { removeDatabase } from "../kernel/job-store-harness"

const args = { route: "implement", repository: "workflowd", prompt: "Review the change." }

test("dispatch has a separate fail-closed credential, with ordinary writes and reads preserved", async () => {
  for (const dispatchToken of [undefined, "dispatch-secret"]) {
    const path = `test-capability-${crypto.randomUUID()}.db`
    const server = await Effect.runPromise(
      startMcpServer({
        WORKFLOWD_MCP_PORT: "0",
        WORKFLOWD_DATABASE_PATH: path,
        WORKFLOWD_MCP_TOKEN: "write-secret",
        WORKFLOWD_MCP_DISPATCH_TOKEN: dispatchToken,
      }),
    )
    const call = async (name: string, token?: string) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments:
              name === "dispatch_agent" ? args : name === "enqueue_probe" ? { host: "mint" } : {},
          },
        }),
      })
      return JSON.stringify(await response.json())
    }
    try {
      for (const token of [undefined, "wrong", "write-secret"]) {
        const result = await call("dispatch_agent", token)
        expect(result).toContain(
          dispatchToken === undefined ? "dispatch is disabled" : "unauthorized",
        )
        expect(result).not.toContain("write-secret")
      }
      if (dispatchToken !== undefined) {
        expect(await call("dispatch_agent", dispatchToken)).toContain("WORKFLOWD_AGENT_RUN_TOKEN")
        expect(await call("enqueue_probe", dispatchToken)).toContain("unauthorized")
      }
      expect(await call("host_health")).not.toContain('"isError":true')
      expect(await call("enqueue_probe", "write-secret")).not.toContain('"isError":true')
    } finally {
      await server.stop()
      await removeDatabase(path)
    }
  }
})

test("startup rejects reusing the ordinary write credential for dispatch", async () => {
  const path = `test-capability-reuse-${crypto.randomUUID()}.db`
  try {
    await expect(
      Effect.runPromise(
        startMcpServer({
          WORKFLOWD_MCP_PORT: "0",
          WORKFLOWD_DATABASE_PATH: path,
          WORKFLOWD_MCP_TOKEN: "same-secret",
          WORKFLOWD_MCP_DISPATCH_TOKEN: "same-secret",
        }),
      ).then(async (server) => {
        await server.stop()
      }),
    ).rejects.toThrow("distinct")
  } finally {
    await removeDatabase(path)
  }
})

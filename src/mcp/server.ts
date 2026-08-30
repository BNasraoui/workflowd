import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { authorizedForWrites, type AgentWaitDaemonConfig, type McpWriteAuth } from "./auth"
import { TOOL_DEFINITIONS, type ToolCallContext, type ToolResult } from "./tools"

export const MCP_SERVER_NAME = "workflowd"
export const MCP_SERVER_VERSION = "0.1.0"
export const MCP_PATH = "/mcp"

/**
 * Runs one already-validated tool call against the authoritative store.
 * The returned promise must never reject for expected failures; those are
 * reported in-band as { isError: true } tool results.
 */
export type RunTool = (name: string, args: unknown, context: ToolCallContext) => Promise<ToolResult>

export type McpHttpHandlerOptions = {
  readonly runTool: RunTool
  readonly auth: McpWriteAuth
  readonly agentWaitDaemon?: AgentWaitDaemonConfig
  readonly now?: () => Date
}

/**
 * Stateless streamable-HTTP MCP handler: each POST gets a fresh Server and
 * transport, so no workflow state ever lives in this process — SQLite stays
 * the single source of truth. Suitable for Bun.serve on loopback with
 * tailscale serve in front.
 */
export const createMcpFetchHandler = (options: McpHttpHandlerOptions) => {
  const now = options.now ?? (() => new Date())
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" })
    }
    if (url.pathname !== MCP_PATH) {
      return Response.json({ error: "not found" }, { status: 404 })
    }
    const context: ToolCallContext = {
      writesConfigured: options.auth.mode === "enabled",
      writesAuthorized: authorizedForWrites(options.auth, request.headers.get("authorization")),
      now,
      ...(options.agentWaitDaemon === undefined
        ? {}
        : { agentWaitDaemon: options.agentWaitDaemon }),
    }
    const server = new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
    }))
    server.setRequestHandler(CallToolRequestSchema, (call) =>
      options.runTool(call.params.name, call.params.arguments, context),
    )
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      return await transport.handleRequest(request)
    } catch {
      // Never leak internals (or credentials) into transport-level errors.
      return Response.json({ error: "internal server error" }, { status: 500 })
    } finally {
      transport.close().catch(() => undefined)
    }
  }
}

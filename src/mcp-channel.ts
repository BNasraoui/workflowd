import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadMcpWriteAuth } from "./mcp/auth"
import { createChannelMcp, DEFAULT_CHANNEL_POLL_MS, type ChannelOptions } from "./mcp/channel"

export const DEFAULT_CHANNEL_MCP_URL = "http://127.0.0.1:8791/mcp"

const parsePollInterval = (raw: string | undefined) => {
  if (raw === undefined || raw === "") return DEFAULT_CHANNEL_POLL_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("WORKFLOWD_CHANNEL_POLL_MS must be a positive integer")
  }
  return value
}

/**
 * Reads the channel's configuration: the HTTP MCP server URL, its bearer
 * (exactly one of WORKFLOWD_MCP_TOKEN or WORKFLOWD_MCP_TOKEN_FILE, as the
 * HTTP server loads it), and the mailbox poll interval.
 */
export async function loadChannelOptions(
  env: Record<string, string | undefined>,
): Promise<ChannelOptions> {
  const auth = await loadMcpWriteAuth(env)
  if (auth.mode === "disabled") {
    throw new Error("Set exactly one of WORKFLOWD_MCP_TOKEN or WORKFLOWD_MCP_TOKEN_FILE")
  }
  const mcpUrl =
    env.WORKFLOWD_MCP_URL === undefined || env.WORKFLOWD_MCP_URL === ""
      ? DEFAULT_CHANNEL_MCP_URL
      : env.WORKFLOWD_MCP_URL
  return {
    mcpUrl,
    token: auth.token,
    pollIntervalMs: parsePollInterval(env.WORKFLOWD_CHANNEL_POLL_MS),
  }
}

if (import.meta.main) {
  const channel = createChannelMcp(await loadChannelOptions(process.env))
  const shutdown = () => void channel.close().finally(() => process.exit(0))
  process.stdin.once("end", shutdown)
  process.stdin.once("close", shutdown)
  await channel.server.connect(new StdioServerTransport())
}

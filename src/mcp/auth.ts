import { createHash, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"

/**
 * The MCP write credential. Reads stay open on the loopback/tailnet
 * transport; the single write tool is refused unless the caller presents
 * this bearer token. When no source is configured, writes are disabled.
 *
 * Sources follow the systemd LoadCredential pattern used by the other
 * workflowd units: WORKFLOWD_MCP_TOKEN carries the value directly,
 * WORKFLOWD_MCP_TOKEN_FILE names a file (e.g. %d/mcp-token). Setting both
 * is a configuration error. Empty strings count as unset so a drop-in can
 * disable a source it cannot remove. Error messages never include the
 * token material itself.
 */
export type McpWriteAuth =
  { readonly mode: "enabled"; readonly token: string } | { readonly mode: "disabled" }

export async function loadMcpWriteAuth(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<McpWriteAuth> {
  const direct = env.WORKFLOWD_MCP_TOKEN
  const file = env.WORKFLOWD_MCP_TOKEN_FILE
  const hasDirect = direct !== undefined && direct !== ""
  const hasFile = file !== undefined && file !== ""
  if (hasDirect && hasFile) {
    throw new Error("Set at most one of WORKFLOWD_MCP_TOKEN or WORKFLOWD_MCP_TOKEN_FILE")
  }
  if (hasDirect) return { mode: "enabled", token: direct }
  if (!hasFile) return { mode: "disabled" }
  let value: string
  try {
    value = await read(file)
  } catch (cause) {
    throw new Error(`Could not read WORKFLOWD_MCP_TOKEN_FILE at ${file}`, { cause })
  }
  value = value.replace(/\r?\n$/, "")
  if (value === "") throw new Error("WORKFLOWD_MCP_TOKEN_FILE must not be empty")
  return { mode: "enabled", token: value }
}

/**
 * How this MCP process reaches the workflowd daemon's agent-wait ingress.
 * `wait_for_agent` proxies rather than duplicating the kernel machinery, so
 * it needs the daemon URL and the daemon's own ingress token. Both must be
 * present or the tool stays disabled; the token follows the same
 * direct/file LoadCredential pattern as the MCP write token.
 */
export type AgentWaitDaemonConfig = { readonly baseUrl: string; readonly token: string }

export async function loadAgentWaitDaemon(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<AgentWaitDaemonConfig | undefined> {
  const baseUrl = env.WORKFLOWD_DAEMON_URL
  const direct = env.WORKFLOWD_AGENT_WAIT_TOKEN
  const file = env.WORKFLOWD_AGENT_WAIT_TOKEN_FILE
  const hasBaseUrl = baseUrl !== undefined && baseUrl !== ""
  const hasDirect = direct !== undefined && direct !== ""
  const hasFile = file !== undefined && file !== ""
  if (hasDirect && hasFile) {
    throw new Error(
      "Set at most one of WORKFLOWD_AGENT_WAIT_TOKEN or WORKFLOWD_AGENT_WAIT_TOKEN_FILE",
    )
  }
  if (!hasBaseUrl && !hasDirect && !hasFile) return undefined
  if (!hasBaseUrl) {
    throw new Error("WORKFLOWD_DAEMON_URL is required when an agent-wait token is configured")
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch (cause) {
    throw new Error("WORKFLOWD_DAEMON_URL must be an absolute HTTP(S) URL", { cause })
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("WORKFLOWD_DAEMON_URL must be an absolute HTTP(S) URL")
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("WORKFLOWD_DAEMON_URL must not include credentials")
  }
  if (!hasDirect && !hasFile) {
    throw new Error(
      "Set exactly one of WORKFLOWD_AGENT_WAIT_TOKEN or WORKFLOWD_AGENT_WAIT_TOKEN_FILE " +
        "when WORKFLOWD_DAEMON_URL is set",
    )
  }
  if (hasDirect) return { baseUrl: parsed.origin, token: direct }
  let value: string
  try {
    value = await read(file!)
  } catch (cause) {
    throw new Error(`Could not read WORKFLOWD_AGENT_WAIT_TOKEN_FILE at ${file}`, { cause })
  }
  value = value.replace(/\r?\n$/, "")
  if (value === "") throw new Error("WORKFLOWD_AGENT_WAIT_TOKEN_FILE must not be empty")
  return { baseUrl: parsed.origin, token: value }
}

/** Constant-time bearer comparison; never logs or echoes either value. */
export function authorizedForWrites(auth: McpWriteAuth, header: string | null): boolean {
  if (auth.mode === "disabled") return false
  if (header?.startsWith("Bearer ") !== true) return false
  const supplied = createHash("sha256").update(header.slice("Bearer ".length)).digest()
  const expected = createHash("sha256").update(auth.token).digest()
  return timingSafeEqual(supplied, expected)
}

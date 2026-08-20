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

/** Constant-time bearer comparison; never logs or echoes either value. */
export function authorizedForWrites(auth: McpWriteAuth, header: string | null): boolean {
  if (auth.mode === "disabled") return false
  if (header?.startsWith("Bearer ") !== true) return false
  const supplied = createHash("sha256").update(header.slice("Bearer ".length)).digest()
  const expected = createHash("sha256").update(auth.token).digest()
  return timingSafeEqual(supplied, expected)
}

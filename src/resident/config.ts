import { isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
export type ResidentConfig = {
  readonly home: string
  readonly socket: string
  readonly progressWindowMs?: number | undefined
}
export function loadResidentConfig(
  env: Record<string, string | undefined>,
): ResidentConfig | undefined {
  if (
    env.WORKFLOWD_CODEX_RESIDENT_ENABLED === undefined ||
    env.WORKFLOWD_CODEX_RESIDENT_ENABLED === "false"
  )
    return undefined
  if (env.WORKFLOWD_CODEX_RESIDENT_ENABLED !== "true")
    throw new Error("WORKFLOWD_CODEX_RESIDENT_ENABLED must be true or false")
  const home = env.WORKFLOWD_CODEX_RESIDENT_HOME ?? ""
  if (!isAbsolute(home) || resolve(home) === resolve(homedir(), ".codex"))
    throw new Error("WORKFLOWD_CODEX_RESIDENT_HOME must be a dedicated absolute directory")
  const socket = env.WORKFLOWD_CODEX_RESIDENT_SOCKET ?? ""
  if (!isAbsolute(socket)) throw new Error("WORKFLOWD_CODEX_RESIDENT_SOCKET must be absolute")
  if (env.WORKFLOWD_CI_ENABLED !== "true")
    throw new Error("Resident CI inboxes require WORKFLOWD_CI_ENABLED=true")
  return { home, socket }
}

export function loadOpenCodeResidentSocket(
  env: Record<string, string | undefined>,
): string | undefined {
  const enabled = env.WORKFLOWD_OPENCODE_RESIDENT_ENABLED
  if (enabled === undefined || enabled === "false") return undefined
  if (enabled !== "true")
    throw new Error("WORKFLOWD_OPENCODE_RESIDENT_ENABLED must be true or false")
  const socket = env.WORKFLOWD_OPENCODE_RESIDENT_SOCKET ?? ""
  if (!isAbsolute(socket) || socket === env.WORKFLOWD_CODEX_RESIDENT_SOCKET)
    throw new Error("WORKFLOWD_OPENCODE_RESIDENT_SOCKET must be an independent absolute path")
  if (env.WORKFLOWD_CI_ENABLED !== "true")
    throw new Error("OpenCode resident inboxes require WORKFLOWD_CI_ENABLED=true")
  return socket
}

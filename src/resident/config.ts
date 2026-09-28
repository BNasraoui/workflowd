import { isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
export type ResidentConfig = { readonly home: string; readonly token: string }
export async function loadResidentConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string>,
): Promise<ResidentConfig | undefined> {
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
  const token =
    env.WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE === undefined
      ? ""
      : (await read(env.WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE)).trim()
  if (token.length < 32)
    throw new Error("WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE must contain at least 32 characters")
  if (env.WORKFLOWD_CI_ENABLED !== "true")
    throw new Error("Resident CI inboxes require WORKFLOWD_CI_ENABLED=true")
  return { home, token }
}

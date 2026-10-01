export type ExecutionCapabilitiesConfig = {
  readonly token: string
  readonly refreshMs: number
  readonly timeoutMs: number
  readonly codexEnabled: boolean
  readonly codexBinary: string
}

function boundedMilliseconds(
  value: string | undefined,
  fallback: number,
  maximum: number,
  name: string,
) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(`${name} must be between 1 and ${maximum}`)
  return parsed
}

export async function loadExecutionCapabilitiesConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string>,
  defaults: { readonly token?: string; readonly codexEnabled: boolean },
): Promise<ExecutionCapabilitiesConfig | undefined> {
  const direct = env.WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN
  const file = env.WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN_FILE
  if (direct !== undefined && file !== undefined)
    throw new Error("Set only one execution-capabilities token source")
  const token =
    file === undefined ? (direct ?? defaults.token) : (await read(file)).replace(/\r?\n$/, "")
  if (token === undefined) return undefined
  if (token.trim().length < 8)
    throw new Error("WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN must contain at least 8 characters")
  const codex = env.WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED
  if (codex !== undefined && codex !== "true" && codex !== "false")
    throw new Error("WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED must be true or false")
  return {
    token,
    refreshMs: boundedMilliseconds(
      env.WORKFLOWD_EXECUTION_CAPABILITIES_REFRESH_MS,
      30_000,
      300_000,
      "WORKFLOWD_EXECUTION_CAPABILITIES_REFRESH_MS",
    ),
    timeoutMs: boundedMilliseconds(
      env.WORKFLOWD_EXECUTION_CAPABILITIES_TIMEOUT_MS,
      10_000,
      30_000,
      "WORKFLOWD_EXECUTION_CAPABILITIES_TIMEOUT_MS",
    ),
    codexEnabled: codex === undefined ? defaults.codexEnabled : codex === "true",
    codexBinary: env.WORKFLOWD_AGENT_RUN_CODEX_BIN ?? "codex",
  }
}

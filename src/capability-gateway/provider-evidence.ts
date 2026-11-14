export type ProviderProtocol = "codex-chatgpt" | "openai-chat"
export interface ProviderResponseEvidence {
  readonly version: 1
  readonly protocol: ProviderProtocol
  readonly status: number
  readonly requestId?: string
  readonly quota: Readonly<Record<string, number>>
}
export type RetainProviderEvidence = (evidence: ProviderResponseEvidence) => Promise<void>

export const credentialPatterns = (secrets: ReadonlyArray<string>) =>
  secrets
    .filter(Boolean)
    .flatMap((value) => [
      value,
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      Buffer.from(value).toString("hex"),
      encodeURIComponent(value),
    ])
    .map((value) => Buffer.from(value))

/** Fixed private projection, never arbitrary headers, account labels or billing metadata. */
export function providerResponseEvidence(
  response: Response,
  protocol: ProviderProtocol,
  secrets: ReadonlyArray<Buffer>,
): ProviderResponseEvidence | undefined {
  const sensitive = [
    "authorization",
    "x-api-key",
    "chatgpt-account-id",
    "openai-organization",
    "openai-project",
  ].flatMap((name) => {
    const value = response.headers.get(name)
    return value === null ? [] : [value]
  })
  if (sensitive.some((value) => value.length > 8192)) return undefined
  const patterns = [...secrets, ...credentialPatterns(sensitive)]
  const reflected = (value: string) =>
    patterns.some((pattern) => Buffer.from(value).includes(pattern))
  const id = response.headers.get("x-request-id")
  const requestId =
    id !== null && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !reflected(id) ? id : undefined
  const fields: ReadonlyArray<readonly [string, number]> =
    protocol === "codex-chatgpt"
      ? [
          ["x-codex-primary-used-percent", 100],
          ["x-codex-primary-window-minutes", 525600],
          ["x-codex-primary-reset-at", 4102444800],
          ["x-codex-secondary-used-percent", 100],
          ["x-codex-secondary-window-minutes", 525600],
          ["x-codex-secondary-reset-at", 4102444800],
        ]
      : [
          ["x-ratelimit-limit-requests", 1e12],
          ["x-ratelimit-remaining-requests", 1e12],
          ["x-ratelimit-limit-tokens", 1e12],
          ["x-ratelimit-remaining-tokens", 1e12],
        ]
  const quota: Record<string, number> = {}
  for (const [name, maximum] of fields) {
    const value = response.headers.get(name)
    if (value === null || !/^\d{1,13}(?:\.\d{1,3})?$/.test(value) || reflected(value)) continue
    const number = Number(value)
    if (number <= maximum && (name.endsWith("used-percent") || Number.isSafeInteger(number)))
      quota[name] = number
  }
  return requestId === undefined && Object.keys(quota).length === 0
    ? undefined
    : {
        version: 1,
        protocol,
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
        quota,
      }
}

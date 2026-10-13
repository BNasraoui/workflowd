import { diagnosticMessage } from "./sandbox/diagnostics"

export type ProviderFailure = {
  readonly reason: "model_at_capacity" | "provider_rate_limited"
  readonly message: string
}

/** Classify native provider errors before redacting their operator-facing preview. */
export function providerFailure(
  message: string | null | undefined,
  codexErrorInfo?: unknown,
): ProviderFailure | undefined {
  let reason: ProviderFailure["reason"] | undefined
  if (codexErrorInfo === "serverOverloaded") reason = "model_at_capacity"
  else if (codexErrorInfo === "rateLimitExceeded") reason = "provider_rate_limited"
  else if (codexErrorInfo != null) {
    if (
      typeof codexErrorInfo === "object" &&
      ["httpConnectionFailed", "responseTooManyFailedAttempts"].some((key) => {
        const response: unknown = Reflect.get(codexErrorInfo, key)
        return (
          typeof response === "object" &&
          response !== null &&
          Reflect.get(response, "httpStatusCode") === 429
        )
      })
    )
      reason = "provider_rate_limited"
  } else if (message != null) {
    const status =
      /(?:\bHTTP(?:\/\d(?:\.\d)?)?(?: status(?: code)?)?|^unexpected status(?: code)?)\s*[:=]?\s+(429|503)\b/i.exec(
        message,
      )?.[1]
    if (/^Selected model is at capacity\b/.test(message)) reason = "model_at_capacity"
    else if (
      status === "429" ||
      /^(?:exceeded retry limit, last status: 429|unexpected status 429)\b/.test(message)
    )
      reason = "provider_rate_limited"
    else if (
      status === "503" &&
      /\bat capacity\b|\bserver[_ ]overloaded\b|\bmodel.{0,40}\boverloaded\b/i.test(message)
    )
      reason = "model_at_capacity"
  }
  return reason === undefined
    ? undefined
    : {
        reason,
        message: diagnosticMessage(message ?? reason),
      }
}

/** Two retries with full jitter over ten and twenty second windows. */
export const providerRetryDelay = (attempt: number, random = Math.random): number | undefined =>
  attempt < 2 ? Math.floor(random() * 10000 * 2 ** attempt) : undefined

/** Unknown item types are unsafe to replay; only known non-tool items qualify. */
export const isNonToolItem = (type: string) =>
  ["userMessage", "agentMessage", "reasoning", "user_message", "agent_message"].includes(type)

/** A summary can omit tools; only a fully hydrated turn proves their absence. */
export const isToolFreeTurn = (
  turn:
    | {
        readonly itemsView?: string | undefined
        readonly items?: ReadonlyArray<{ readonly type: string }> | undefined
      }
    | undefined,
) =>
  turn?.items !== undefined &&
  (turn.itemsView === undefined || turn.itemsView === "full") &&
  turn.items.every((item) => isNonToolItem(item.type))

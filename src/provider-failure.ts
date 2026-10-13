export type ProviderFailure = {
  readonly reason: "model_at_capacity" | "provider_rate_limited"
  readonly message: string
}

/** Keep the provider's text for the operator; classify only explicit transient failures. */
export function providerFailure(message: string | null | undefined): ProviderFailure | undefined {
  if (message == null) return undefined
  if (/\bat capacity\b|\bserver[_ ]overloaded\b|\bmodel.{0,40}\boverloaded\b/i.test(message))
    return { reason: "model_at_capacity", message }
  if (/\brate[ _-]?limit(?:ed|[ _-]exceeded)?\b|\btoo many requests\b|\b429\b/i.test(message))
    return { reason: "provider_rate_limited", message }
  return undefined
}

/** Two retries, one and two seconds apart, within the same native session. */
export const providerRetryDelay = (attempt: number): number | undefined =>
  attempt < 2 ? 1000 * 2 ** attempt : undefined

/** Unknown item types are unsafe to replay; only known non-tool items qualify. */
export const isNonToolItem = (type: string) =>
  [
    "userMessage",
    "agentMessage",
    "reasoning",
    "plan",
    "user_message",
    "agent_message",
    "todo_list",
  ].includes(type)

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

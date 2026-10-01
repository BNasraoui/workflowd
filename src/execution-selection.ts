import { Schema } from "effect"
import { utf8BoundedText } from "./agent-wait-contract"
import type { ExecutionCapabilities, ExecutionCapability } from "./execution-capability-contract"

export class ExecutionSelectionError extends Schema.TaggedError<ExecutionSelectionError>()(
  "ExecutionSelectionError",
  {
    reason: Schema.Literals(["unsupported_thinking", "model_not_available"]),
    detail: Schema.String,
  },
) {}

const text = utf8BoundedText(256)
export const ThinkingSelection = Schema.Struct({
  variant: Schema.optionalKey(text),
  effort: Schema.optionalKey(text),
  budgets: Schema.optionalKey(
    Schema.Array(Schema.Struct({ parameter: text, value: Schema.Finite, unit: text })).pipe(
      Schema.check(Schema.isMaxLength(16)),
    ),
  ),
})
export type ThinkingSelection = typeof ThinkingSelection.Type
export const RequestedSelection = Schema.Struct({
  model: Schema.optionalKey(text),
  route: Schema.optionalKey(text),
  provider: Schema.optionalKey(Schema.NullOr(text)),
  executor: Schema.optionalKey(text),
  modelIdentity: Schema.optionalKey(Schema.Literals(["native", "catalog"])),
  thinking: Schema.optionalKey(ThinkingSelection),
  allowUnknownAccess: Schema.optionalKey(Schema.Boolean),
})
export type RequestedSelection = typeof RequestedSelection.Type
export const ResolvedSelection = Schema.Struct({
  host: Schema.String,
  executor: Schema.String,
  executorKind: Schema.Literals(["opencode", "codex", "claude"]),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  selectionModel: Schema.NullOr(Schema.String),
  thinking: ThinkingSelection,
  availability: Schema.Literals(["available", "unknown"]),
  evidence: Schema.Literals(["advertised", "configured", "runtime"]),
})
export type ResolvedSelection = typeof ResolvedSelection.Type
export type SelectionRefusal =
  | "unknown_model"
  | "ambiguous_model"
  | "model_not_available"
  | "model_access_unknown"
  | "unsupported_thinking"
  | "executor_unavailable"

const sameBudgets = (left: ThinkingSelection["budgets"], right: ThinkingSelection["budgets"]) => {
  const sorted = (values: ThinkingSelection["budgets"]) =>
    JSON.stringify([...(values ?? [])].sort((a, b) => a.parameter.localeCompare(b.parameter)))
  return sorted(left) === sorted(right)
}

/** OpenCode applies catalog variants, not arbitrary raw provider parameters. */
function thinkingFor(
  capability: ExecutionCapability,
  kind: ResolvedSelection["executorKind"],
  requested?: ThinkingSelection,
): ThinkingSelection | undefined {
  const advertised = capability.thinking
  const explicit = requested !== undefined && Object.keys(requested).length > 0
  if (!explicit)
    return {
      ...(advertised.defaultEffort === undefined ? {} : { effort: advertised.defaultEffort }),
      ...(kind === "opencode" && advertised.defaultBudgets !== undefined
        ? { budgets: advertised.defaultBudgets }
        : {}),
    }
  if (kind === "codex") {
    if (
      requested.variant !== undefined ||
      requested.budgets !== undefined ||
      requested.effort === undefined
    )
      return undefined
    return advertised.efforts?.some((e) => e.id === requested.effort)
      ? { effort: requested.effort }
      : undefined
  }
  if (kind !== "opencode") return undefined
  const matches = (advertised.variants ?? []).filter(
    (v) =>
      (requested.variant === undefined || requested.variant === v.id) &&
      (requested.effort === undefined || requested.effort === v.effort) &&
      (requested.budgets === undefined || sameBudgets(requested.budgets, v.budgets)),
  )
  if (matches.length !== 1) return undefined
  const variant = matches[0]!
  return {
    variant: variant.id,
    ...(variant.effort === undefined ? {} : { effort: variant.effort }),
    ...(variant.budgets === undefined ? {} : { budgets: variant.budgets }),
  }
}

/** Selection IDs and native IDs occupy separate namespaces. Providers never break ties implicitly. */
export function resolveExecutionSelection(
  catalog: ExecutionCapabilities,
  requested: RequestedSelection,
):
  | { readonly outcome: "resolved"; readonly selection: ResolvedSelection }
  | { readonly outcome: "refused"; readonly reason: SelectionRefusal } {
  const candidates = catalog.capabilities.filter(
    (c) =>
      (requested.modelIdentity === "catalog" ? c.selectionModel : c.identity.model) ===
        requested.model &&
      (requested.provider === undefined || c.identity.provider === requested.provider) &&
      (requested.executor === undefined || c.identity.executor === requested.executor),
  )
  if (candidates.length === 0)
    return {
      outcome: "refused",
      reason:
        requested.executor !== undefined &&
        !catalog.sources.some((s) => s.executor === requested.executor && s.status === "available")
          ? "executor_unavailable"
          : "unknown_model",
    }
  const enabled = candidates.filter((c) =>
    catalog.sources.some(
      (s) =>
        s.executor === c.identity.executor &&
        s.status === "available" &&
        !s.stale &&
        (s.kind === "codex" || s.kind === "claude" || s.kind === "opencode"),
    ),
  )
  if (enabled.length === 0) return { outcome: "refused", reason: "executor_unavailable" }
  const available = enabled.filter((c) => c.availability !== "unavailable")
  if (available.length === 0) return { outcome: "refused", reason: "model_not_available" }
  const accessible = available.filter(
    (c) => c.availability === "available" || requested.allowUnknownAccess === true,
  )
  if (accessible.length === 0) return { outcome: "refused", reason: "model_access_unknown" }
  const compatible = accessible.flatMap((c) => {
    const source = catalog.sources.find(
      (s) => s.executor === c.identity.executor && s.status === "available" && !s.stale,
    )
    if (
      source === undefined ||
      (source.kind !== "codex" && source.kind !== "claude" && source.kind !== "opencode")
    )
      return []
    const kind: ResolvedSelection["executorKind"] = source.kind
    const thinking = thinkingFor(c, kind, requested.thinking)
    return thinking === undefined ? [] : [{ capability: c, kind, thinking }]
  })
  if (compatible.length === 0) return { outcome: "refused", reason: "unsupported_thinking" }
  const identities = new Set(
    compatible.map((c) =>
      JSON.stringify([c.capability.identity.provider, c.capability.identity.model]),
    ),
  )
  if (identities.size !== 1) return { outcome: "refused", reason: "ambiguous_model" }
  const order = { codex: 0, claude: 1, opencode: 2 }
  compatible.sort(
    (a, b) =>
      Number(a.capability.availability !== "available") -
        Number(b.capability.availability !== "available") ||
      order[a.kind] - order[b.kind] ||
      a.capability.identity.executor.localeCompare(b.capability.identity.executor) ||
      a.capability.selectionModel.localeCompare(b.capability.selectionModel),
  )
  const selected = compatible[0]!
  const c = selected.capability
  return {
    outcome: "resolved",
    selection: {
      host: c.identity.host,
      executor: c.identity.executor,
      executorKind: selected.kind,
      provider: c.identity.provider,
      model: c.identity.model,
      selectionModel: c.selectionModel,
      thinking: selected.thinking,
      availability: c.availability === "available" ? "available" : "unknown",
      evidence: "advertised",
    },
  }
}

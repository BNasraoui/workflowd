import { Schema } from "effect"
import { utf8BoundedText } from "./agent-wait-contract"
import type { ExecutionCapabilities, ExecutionCapability } from "./execution-capability-contract"
import { compareVersions, modelFamily } from "./execution/family"
import type { ExecutionPolicy } from "./execution/policy"

export class ExecutionSelectionError extends Schema.TaggedError<ExecutionSelectionError>()(
  "ExecutionSelectionError",
  {
    reason: Schema.Literals(["unsupported_thinking", "unsupported_speed", "model_not_available"]),
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
  host: Schema.optionalKey(text),
  harness: Schema.optionalKey(Schema.Literals(["opencode", "codex", "claude"])),
  family: Schema.optionalKey(text),
  version: Schema.optionalKey(text),
  intent: Schema.optionalKey(text),
  speed: Schema.optionalKey(text),
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
  policyRevision: Schema.optionalKey(text),
  catalogObservedAt: Schema.optionalKey(Schema.String),
  adapterProtocol: Schema.optionalKey(Schema.String),
  speedEvidence: Schema.optionalKey(Schema.Literals(["native-unconfirmed"])),
  speed: Schema.optionalKey(Schema.Struct({ id: text, native: Schema.optionalKey(text) })),
  family: Schema.optionalKey(text),
  version: Schema.optionalKey(text),
  host: Schema.String,
  catalogHost: Schema.optionalKey(Schema.String),
  executor: Schema.String,
  executorKind: Schema.Literals(["opencode", "codex", "claude"]),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  selectionModel: Schema.NullOr(Schema.String),
  thinking: ThinkingSelection,
  thinkingEvidence: Schema.optionalKey(Schema.Literals(["native-unconfirmed"])),
  availability: Schema.Literals(["available", "unknown"]),
  evidence: Schema.Literals(["advertised", "configured", "runtime"]),
})
export type ResolvedSelection = typeof ResolvedSelection.Type
export type SelectionRefusal =
  | "invalid_selection"
  | "host_unavailable"
  | "ambiguous_family"
  | "unknown_intent"
  | "unsupported_speed"
  | "unknown_family"
  | "unsupported_version"
  | "unknown_model"
  | "ambiguous_model"
  | "model_not_available"
  | "model_access_unknown"
  | "unsupported_thinking"
  | "executor_unavailable"

export function validSelection(requested: RequestedSelection): boolean {
  const targets = [requested.route, requested.model, requested.family].filter(
    (v) => v !== undefined,
  )
  return (
    (targets.length === 1 || (targets.length === 0 && requested.intent !== undefined)) &&
    (requested.version === undefined || requested.family !== undefined) &&
    (requested.family === undefined || requested.modelIdentity === undefined) &&
    (requested.route === undefined ||
      (requested.provider === undefined &&
        requested.executor === undefined &&
        requested.harness === undefined &&
        requested.host === undefined &&
        requested.version === undefined &&
        requested.intent === undefined &&
        requested.speed === undefined))
  )
}

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
  allowUnconfirmedClaudeThinking = false,
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
  if (kind === "codex" || (kind === "claude" && allowUnconfirmedClaudeThinking)) {
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
  input: RequestedSelection,
  policy?: ExecutionPolicy,
):
  | { readonly outcome: "resolved"; readonly selection: ResolvedSelection }
  | { readonly outcome: "refused"; readonly reason: SelectionRefusal } {
  if (!validSelection(input)) return { outcome: "refused", reason: "invalid_selection" }
  const preset = policy?.intents?.find((p) => p.name === input.intent)
  if (input.intent !== undefined && preset === undefined)
    return { outcome: "refused", reason: "unknown_intent" }
  const highLevel = input.family !== undefined || input.intent !== undefined
  const {
    name: _name,
    family: presetFamily,
    model: presetModel,
    version: presetVersion,
    ...defaults
  } = preset ?? { name: "" }
  const targetDefaults =
    input.model !== undefined || input.family !== undefined
      ? {}
      : {
          ...(presetFamily === undefined ? {} : { family: presetFamily }),
          ...(presetModel === undefined ? {} : { model: presetModel }),
          ...(presetVersion === undefined ? {} : { version: presetVersion }),
        }
  const requested: RequestedSelection = {
    ...(highLevel && policy?.preferredHost !== undefined ? { host: policy.preferredHost } : {}),
    ...defaults,
    ...targetDefaults,
    ...(highLevel && policy?.allowUnknownAccess !== undefined
      ? { allowUnknownAccess: policy.allowUnknownAccess }
      : {}),
    ...input,
  }
  const result = resolveConcrete(catalog, requested, policy, highLevel)
  return result.outcome === "resolved" && highLevel && policy !== undefined
    ? { outcome: "resolved", selection: { ...result.selection, policyRevision: policy.revision } }
    : result
}

function resolveFamily(
  catalog: ExecutionCapabilities,
  requested: RequestedSelection,
  policy?: ExecutionPolicy,
  highLevel = false,
):
  | { readonly outcome: "resolved"; readonly selection: ResolvedSelection }
  | { readonly outcome: "refused"; readonly reason: SelectionRefusal } {
  const members = catalog.capabilities.flatMap((capability) => {
    const family = modelFamily(capability, policy)
    if (family === undefined) return []
    return family.family === requested.family &&
      (requested.provider === undefined || capability.identity.provider === requested.provider) &&
      (requested.executor === undefined || capability.identity.executor === requested.executor)
      ? [{ capability, family }]
      : []
  })
  if (members.length === 0) return { outcome: "refused", reason: "unknown_family" }
  const harness = requested.harness ?? members[0]?.family.nativeHarness
  if (harness === undefined) return { outcome: "refused", reason: "unknown_family" }
  const native = members.filter(
    (m) =>
      catalog.sources.some(
        (s) =>
          s.executor === m.capability.identity.executor &&
          (s.host === undefined || s.host === m.capability.identity.host) &&
          s.kind === harness &&
          s.status === "available" &&
          !s.stale,
      ) &&
      m.capability.availability !== "unavailable" &&
      (requested.version !== undefined || m.capability.pickerEligible !== false),
  )
  if (native.length === 0) return { outcome: "refused", reason: "executor_unavailable" }
  const versions = native.filter(
    (m) => requested.version === undefined || m.family.version === requested.version,
  )
  if (versions.length === 0) return { outcome: "refused", reason: "unsupported_version" }
  if (new Set(versions.map((m) => m.capability.identity.provider)).size > 1)
    return { outcome: "refused", reason: "ambiguous_family" }
  versions.sort((a, b) => compareVersions(b.family.version, a.family.version))
  const newest = versions[0]
  if (newest === undefined) return { outcome: "refused", reason: "unsupported_version" }
  const identities = new Set(
    versions
      .filter((m) => compareVersions(m.family.version, newest.family.version) === 0)
      .map((m) => JSON.stringify([m.capability.identity.provider, m.capability.identity.model])),
  )
  if (identities.size !== 1) return { outcome: "refused", reason: "ambiguous_family" }
  const { family: _family, version: _version, intent: _intent, ...qualifiers } = requested
  const result = resolveConcrete(
    catalog,
    {
      ...qualifiers,
      model: newest.capability.identity.model,
      harness,
    },
    policy,
    highLevel,
  )
  return result.outcome === "refused"
    ? result
    : {
        outcome: "resolved",
        selection: {
          ...result.selection,
          family: newest.family.family,
          version: newest.family.version,
        },
      }
}

function resolveConcrete(
  catalog: ExecutionCapabilities,
  requested: RequestedSelection,
  policy?: ExecutionPolicy,
  highLevel = false,
): ReturnType<typeof resolveFamily> {
  if (!validSelection(requested)) return { outcome: "refused", reason: "invalid_selection" }
  if (requested.family !== undefined) return resolveFamily(catalog, requested, policy, highLevel)
  const candidates = catalog.capabilities.filter(
    (c) =>
      (requested.modelIdentity === "catalog" ? c.selectionModel : c.identity.model) ===
        requested.model &&
      (requested.provider === undefined || c.identity.provider === requested.provider) &&
      (requested.harness === undefined ||
        catalog.sources.some(
          (s) =>
            s.executor === c.identity.executor &&
            (s.host === undefined || s.host === c.identity.host) &&
            s.kind === requested.harness,
        )) &&
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
        (s.host === undefined || s.host === c.identity.host) &&
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
      (s) =>
        s.executor === c.identity.executor &&
        (s.host === undefined || s.host === c.identity.host) &&
        s.status === "available" &&
        !s.stale,
    )
    if (
      source === undefined ||
      (source.kind !== "codex" && source.kind !== "claude" && source.kind !== "opencode")
    )
      return []
    const kind: ResolvedSelection["executorKind"] = source.kind
    const thinking = thinkingFor(
      c,
      kind,
      requested.thinking,
      highLevel && policy?.allowUnconfirmedClaudeThinking,
    )
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
      a.capability.identity.host.localeCompare(b.capability.identity.host) ||
      a.capability.selectionModel.localeCompare(b.capability.selectionModel),
  )
  const selected = compatible[0]!
  const c = selected.capability
  const speedId = requested.speed ?? c.speed?.defaultTier
  const speed = speedId === undefined ? undefined : c.speed?.tiers?.find((t) => t.id === speedId)
  if (speedId !== undefined && (c.speed?.status !== "advertised" || speed === undefined))
    return { outcome: "refused", reason: "unsupported_speed" }
  return {
    outcome: "resolved",
    selection: {
      host: requested.host ?? c.identity.host,
      catalogHost: c.identity.host,
      executor: c.identity.executor,
      executorKind: selected.kind,
      provider: c.identity.provider,
      model: c.identity.model,
      selectionModel: c.selectionModel,
      thinking: selected.thinking,
      catalogObservedAt: c.observedAt,
      adapterProtocol:
        catalog.sources.find(
          (s) =>
            s.executor === c.identity.executor &&
            (s.host === undefined || s.host === c.identity.host),
        )?.protocol ?? "unknown",
      ...(selected.kind === "claude" && selected.thinking.effort !== undefined
        ? { thinkingEvidence: "native-unconfirmed" as const }
        : {}),
      ...(speed === undefined ? {} : { speed, speedEvidence: "native-unconfirmed" as const }),
      availability: c.availability === "available" ? "available" : "unknown",
      evidence: "advertised",
    },
  }
}

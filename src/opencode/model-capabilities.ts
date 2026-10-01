import type { Model } from "@opencode-ai/client/effect"
import { Option, Schema } from "effect"
import type { ExecutionThinking } from "../execution-capability-contract"

const Settings = Schema.Struct({
  reasoningEffort: Schema.optionalKey(Schema.String),
  reasoning_effort: Schema.optionalKey(Schema.String),
  reasoning: Schema.optionalKey(Schema.Struct({ effort: Schema.optionalKey(Schema.String) })),
  reasoningBudget: Schema.optionalKey(Schema.Finite),
  thinkingBudget: Schema.optionalKey(Schema.Finite),
  thinking: Schema.optionalKey(
    Schema.Struct({
      budgetTokens: Schema.optionalKey(Schema.Finite),
      budget_tokens: Schema.optionalKey(Schema.Finite),
    }),
  ),
  thinkingConfig: Schema.optionalKey(
    Schema.Struct({ thinkingBudget: Schema.optionalKey(Schema.Finite) }),
  ),
})

function thinkingSettings(value: unknown) {
  const decoded = Schema.decodeUnknownOption(Settings)(value)
  if (Option.isNone(decoded)) return {}
  const settings = decoded.value
  const budgets: Array<{ parameter: string; value: number; unit: string }> = []
  for (const [parameter, amount] of [
    ["reasoningBudget", settings.reasoningBudget],
    ["thinkingBudget", settings.thinkingBudget],
    ["thinking.budgetTokens", settings.thinking?.budgetTokens],
    ["thinking.budget_tokens", settings.thinking?.budget_tokens],
    ["thinkingConfig.thinkingBudget", settings.thinkingConfig?.thinkingBudget],
  ] as const) {
    if (amount !== undefined) budgets.push({ parameter, value: amount, unit: "tokens" })
  }
  const effort = settings.reasoning_effort ?? settings.reasoningEffort ?? settings.reasoning?.effort
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(budgets.length === 0 ? {} : { budgets }),
  }
}

function thinkingOverlays(settings: unknown, body: unknown) {
  const base = thinkingSettings(settings)
  const overlay = thinkingSettings(body)
  // Raw body wins for the same native parameter, while distinct parameters survive.
  const budgets = new Map([
    ...(base.budgets ?? []).map((budget) => [budget.parameter, budget] as const),
    ...(overlay.budgets ?? []).map((budget) => [budget.parameter, budget] as const),
  ])
  const effort = overlay.effort ?? base.effort
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(budgets.size === 0 ? {} : { budgets: Array.from(budgets.values()) }),
  }
}

export type OpenCodeModelAvailability = {
  readonly providerID: string
  readonly id: string
  readonly nativeModelID?: string
  readonly name?: string
  readonly enabled?: boolean
  readonly capabilities?: Model.Info["capabilities"]
  readonly limits?: Model.Info["limit"]
  readonly variants?: ExecutionThinking["variants"]
  readonly defaults?: ReturnType<typeof thinkingSettings>
}

/** Only catalog fields and known thinking parameters cross the public seam. Never copy overlays. */
export function publicOpenCodeModel(model: Model.Info): OpenCodeModelAvailability {
  return {
    providerID: model.providerID,
    id: model.id,
    nativeModelID: model.modelID,
    name: model.name,
    enabled: model.enabled,
    capabilities: model.capabilities,
    limits: model.limit,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      ...thinkingOverlays(variant.settings, variant.body),
    })),
    defaults: thinkingOverlays(model.settings, model.body),
  }
}

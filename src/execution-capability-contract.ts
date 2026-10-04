import { Schema } from "effect"

const Budget = Schema.Struct({
  parameter: Schema.String,
  value: Schema.Finite,
  unit: Schema.String,
})
const ThinkingSettings = {
  effort: Schema.optionalKey(Schema.String),
  budgets: Schema.optionalKey(Schema.Array(Budget)),
}

export const ExecutionThinking = Schema.Struct({
  status: Schema.Literals(["advertised", "unknown", "unsupported"]),
  reasoning: Schema.optionalKey(Schema.Struct({ supported: Schema.Boolean })),
  variants: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, ...ThinkingSettings })),
  ),
  efforts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: Schema.String, description: Schema.optionalKey(Schema.String) }),
    ),
  ),
  defaultEffort: Schema.optionalKey(Schema.String),
  defaultBudgets: Schema.optionalKey(Schema.Array(Budget)),
})
export type ExecutionThinking = Schema.Schema.Type<typeof ExecutionThinking>

export const ExecutionSpeed = Schema.Struct({
  status: Schema.Literals(["advertised", "unknown", "unsupported"]),
  tiers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, native: Schema.optionalKey(Schema.String) })),
  ),
  defaultTier: Schema.optionalKey(Schema.String),
})

export const ExecutionCapability = Schema.Struct({
  identity: Schema.Struct({
    host: Schema.String,
    executor: Schema.String,
    provider: Schema.NullOr(Schema.String),
    model: Schema.String,
  }),
  selectionModel: Schema.String,
  name: Schema.optionalKey(Schema.String),
  thinking: ExecutionThinking,
  speed: Schema.optionalKey(ExecutionSpeed),
  defaultModel: Schema.optionalKey(Schema.Boolean),
  pickerEligible: Schema.optionalKey(Schema.Boolean),
  tools: Schema.optionalKey(Schema.Boolean),
  responsesWebsockets: Schema.optionalKey(Schema.Boolean),
  limits: Schema.optionalKey(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optionalKey(Schema.Finite),
      output: Schema.Finite,
    }),
  ),
  modalities: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Array(Schema.String),
      output: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  observedAt: Schema.String,
  availability: Schema.Literals(["available", "unavailable", "unknown"]),
})
export type ExecutionCapability = Schema.Schema.Type<typeof ExecutionCapability>

export const ExecutionCapabilities = Schema.Struct({
  capabilities: Schema.Array(ExecutionCapability),
  sources: Schema.Array(
    Schema.Struct({
      host: Schema.optionalKey(Schema.String),
      executor: Schema.String,
      kind: Schema.String,
      protocol: Schema.String,
      status: Schema.Literals(["available", "unavailable", "unsupported", "unauthenticated"]),
      checkedAt: Schema.String,
      observedAt: Schema.NullOr(Schema.String),
      freshUntil: Schema.NullOr(Schema.String),
      stale: Schema.Boolean,
    }),
  ),
})
export type ExecutionCapabilities = Schema.Schema.Type<typeof ExecutionCapabilities>

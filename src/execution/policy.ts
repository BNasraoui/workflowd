import { Schema } from "effect"
import { ThinkingSelection } from "../execution-selection"

const Name = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)))
const Harness = Schema.Literals(["codex", "claude", "opencode"])
const Version = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d+(?:\.\d+)*$/)))
const Preset = Schema.Struct({
  name: Name,
  family: Schema.optionalKey(Name),
  model: Schema.optionalKey(Name),
  harness: Schema.optionalKey(Harness),
  host: Schema.optionalKey(Name),
  version: Schema.optionalKey(Version),
  thinking: Schema.optionalKey(ThinkingSelection),
  speed: Schema.optionalKey(Name),
})
export const ExecutionPolicy = Schema.Struct({
  revision: Name,
  preferredHost: Schema.optionalKey(Name),
  allowUnknownAccess: Schema.optionalKey(Schema.Boolean),
  allowUnconfirmedClaudeThinking: Schema.optionalKey(Schema.Boolean),
  intents: Schema.optionalKey(Schema.Array(Preset)),
  families: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Name,
        harness: Harness,
        models: Schema.Array(
          Schema.Struct({
            model: Name,
            version: Version,
            provider: Schema.optionalKey(Schema.NullOr(Name)),
          }),
        ),
      }),
    ),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((policy) => {
      for (const entries of [policy.intents ?? [], policy.families ?? []])
        if (new Set(entries.map((e) => e.name)).size !== entries.length)
          return "Policy names must be unique"
      for (const intent of policy.intents ?? [])
        if (
          (intent.family === undefined) === (intent.model === undefined) ||
          (intent.version !== undefined && intent.family === undefined)
        )
          return "Each intent requires one family or model; version requires family"
      const mappings = (policy.families ?? []).flatMap((family) => family.models)
      for (const [index, mapping] of mappings.entries())
        if (
          mappings
            .slice(0, index)
            .some(
              (previous) =>
                previous.model === mapping.model &&
                (previous.provider === undefined ||
                  mapping.provider === undefined ||
                  previous.provider === mapping.provider),
            )
        )
          return "Custom family model mappings must not overlap"
      return true
    }),
  ),
)
export type ExecutionPolicy = typeof ExecutionPolicy.Type

export async function loadExecutionPolicy(
  path: string | undefined,
  read: (path: string) => Promise<string>,
): Promise<ExecutionPolicy | undefined> {
  if (path === undefined) return undefined
  return Schema.decodeUnknownSync(ExecutionPolicy)(JSON.parse(await read(path)), {
    onExcessProperty: "error",
  })
}

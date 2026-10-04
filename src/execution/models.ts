import { Schema } from "effect"
import {
  ExecutionCapabilities,
  ExecutionSpeed,
  ExecutionThinking,
} from "../execution-capability-contract"
import { compareVersions, modelFamily } from "./family"
import type { ExecutionPolicy } from "./policy"

export const ModelFilters = Schema.Struct({
  host: Schema.optionalKey(Schema.NonEmptyString),
  harness: Schema.optionalKey(Schema.NonEmptyString),
  family: Schema.optionalKey(Schema.NonEmptyString),
})
export type ModelFilters = typeof ModelFilters.Type
export const ModelListing = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      host: Schema.String,
      catalogHost: Schema.String,
      harness: Schema.String,
      executor: Schema.String,
      provider: Schema.NullOr(Schema.String),
      model: Schema.String,
      selectionModel: Schema.String,
      family: Schema.optionalKey(Schema.String),
      version: Schema.optionalKey(Schema.String),
      preferredHarness: Schema.optionalKey(Schema.String),
      latest: Schema.Boolean,
      pickerEligible: Schema.optionalKey(Schema.Boolean),
      thinking: ExecutionThinking,
      speed: Schema.optionalKey(ExecutionSpeed),
      availability: Schema.Literals(["available", "unavailable", "unknown"]),
      observedAt: Schema.String,
    }),
  ),
  sources: ExecutionCapabilities.fields.sources,
  intents: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      family: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String),
      harness: Schema.optionalKey(Schema.String),
    }),
  ),
  policyRevision: Schema.optionalKey(Schema.String),
})

export function listModels(
  catalog: ExecutionCapabilities,
  filters: ModelFilters = {},
  policy?: ExecutionPolicy,
): typeof ModelListing.Type {
  const models = catalog.capabilities.flatMap((capability) => {
    const source = catalog.sources.find(
      (s) =>
        s.executor === capability.identity.executor &&
        (s.host === undefined || s.host === capability.identity.host),
    )
    const family = modelFamily(capability, policy)
    if (
      (filters.harness !== undefined && filters.harness !== source?.kind) ||
      (filters.family !== undefined && filters.family !== family?.family)
    )
      return []
    return [
      {
        host: filters.host ?? capability.identity.host,
        catalogHost: capability.identity.host,
        harness: source?.kind ?? "unknown",
        executor: capability.identity.executor,
        provider: capability.identity.provider,
        model: capability.identity.model,
        selectionModel: capability.selectionModel,
        ...(family === undefined
          ? {}
          : {
              family: family.family,
              version: family.version,
              preferredHarness: family.nativeHarness,
            }),
        latest: false,
        eligible: source?.status === "available" && !source.stale,
        ...(capability.pickerEligible === undefined
          ? {}
          : { pickerEligible: capability.pickerEligible }),
        thinking: capability.thinking,
        ...(capability.speed === undefined ? {} : { speed: capability.speed }),
        availability: capability.availability,
        observedAt: capability.observedAt,
      },
    ]
  })
  return {
    models: models.map(({ eligible, ...model }) => ({
      ...model,
      latest:
        model.version !== undefined &&
        eligible &&
        model.pickerEligible !== false &&
        model.availability !== "unavailable" &&
        !models.some(
          (other) =>
            other.host === model.host &&
            other.harness === model.harness &&
            other.provider === model.provider &&
            other.family === model.family &&
            other.availability !== "unavailable" &&
            other.eligible &&
            other.pickerEligible !== false &&
            other.version !== undefined &&
            compareVersions(other.version, model.version ?? "0") > 0,
        ),
    })),
    sources: catalog.sources.filter(
      (s) => filters.harness === undefined || s.kind === filters.harness,
    ),
    intents: (policy?.intents ?? []).map(({ name, family, model, harness }) => ({
      name,
      ...(family === undefined ? {} : { family }),
      ...(model === undefined ? {} : { model }),
      ...(harness === undefined ? {} : { harness }),
    })),
    ...(policy === undefined ? {} : { policyRevision: policy.revision }),
  }
}

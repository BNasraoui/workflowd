import { Effect, Schema } from "effect"

export const CiTarget = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/i)),
})
export type CiTarget = typeof CiTarget.Type

export const CiCompletion = Schema.Struct({
  _tag: Schema.Literal("CiCompletion"),
  ...CiTarget.fields,
  installationId: Schema.Int.check(Schema.isGreaterThan(0)),
  source: Schema.Literals(["workflow_run", "check_suite"]),
  sourceId: Schema.Int.check(Schema.isGreaterThan(0)),
  conclusion: Schema.NullOr(Schema.NonEmptyString),
})
export type CiCompletion = typeof CiCompletion.Type

const Payload = Schema.Struct({
  action: Schema.String,
  installation: Schema.optional(Schema.Struct({ id: Schema.Int })),
  repository: Schema.Struct({ full_name: Schema.String }),
  workflow_run: Schema.optional(Schema.Unknown),
  check_suite: Schema.optional(Schema.Unknown),
})
const Completed = Schema.Struct({
  id: Schema.Int,
  head_sha: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
})

export const decodeCiCompletion = (source: "workflow_run" | "check_suite", payload: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(Payload)(payload)
    if (decoded.action !== "completed" || decoded.installation === undefined) {
      return { _tag: "Ignored" as const, reason: "ci-not-completed-or-no-installation" }
    }
    const run = yield* Schema.decodeUnknownEffect(Completed)(decoded[source])
    return yield* Schema.decodeUnknownEffect(CiCompletion)({
      _tag: "CiCompletion",
      repository: decoded.repository.full_name.toLowerCase(),
      sha: run.head_sha.toLowerCase(),
      installationId: decoded.installation.id,
      source,
      sourceId: run.id,
      conclusion: run.conclusion,
    })
  })

import { Effect, Schema } from "effect"

/**
 * The control socket's protocol, which workflowd and its capability gateway both import. Each
 * connection carries one request and one answer, each a frame of a 4-byte big-endian length and
 * that many bytes of JSON. A request is `{ verb, body }`; an answer is `{ ok: true, value }` or
 * `{ ok: false, error }`. Neither side imports the other's store: this module holds all they share.
 */
export const maxControlFrame = 1 << 20

export const controlFrame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

export const ControlRequest = Schema.fromJsonString(
  Schema.Struct({ verb: Schema.String, body: Schema.Unknown }),
)

export const ControlAnswer = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  ]),
)

/** Why the gateway refused a request; `unavailable` is a failure the caller may retry. */
export type ControlError = "length" | "body" | "verb" | "caller" | "refused" | "unavailable"

export const SessionPolicy = Schema.Struct({
  privateBootstrap: Schema.Struct({
    mode: Schema.Literal("actions-native"),
    repositoryOwnerId: Schema.Int,
  }),
  repository: Schema.String,
  repositoryId: Schema.Int,
  appActorId: Schema.Int,
  workflowSha: Schema.String,
  toolingSha: Schema.optionalKey(Schema.String),
})

/**
 * The largest token count of one model call: ten times the largest context window of a model.
 * The gateway takes no larger count from a usage that the provider reports, and a call asks no
 * more output tokens.
 */
export const maxCallTokens = 10_000_000
/**
 * The most model calls of one run. Each call adds at most `maxCallTokens` to each count of its
 * run, so each count stays below 2^53, the largest integer that a number holds exactly.
 */
const maxRunCalls = 100_000_000
/** An integer from 1 to `maximum`. */
const count = (maximum: number) =>
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximum))
const runBudgetFields = {
  calls: count(maxRunCalls),
  // The most output tokens that the most calls can be charged: a larger budget holds nothing back.
  outputTokens: count(maxRunCalls * maxCallTokens),
  maxTokens: count(maxCallTokens),
}
/** A budget whose one call asks more than all its output tokens refuses that call at once. */
const callWithinBudget = Schema.makeFilter(
  (budget: { readonly outputTokens: number; readonly maxTokens: number }) =>
    budget.maxTokens <= budget.outputTokens
      ? true
      : { path: ["maxTokens"], issue: "Expected a value of at most outputTokens" },
)
/**
 * The budget of one run: the model calls the gateway sends to the provider for it, the output
 * tokens they may make, and the most output tokens (`max_tokens`) one call may ask.
 */
export const RunBudget = Schema.Struct(runBudgetFields).check(callWithinBudget)
export type RunBudget = typeof RunBudget.Type
/** `RunBudget` as a config names it: each key that it leaves out is the key of `defaults`. */
export const configuredRunBudget = (defaults: RunBudget) =>
  Schema.Struct({
    calls: runBudgetFields.calls.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(defaults.calls)),
    ),
    outputTokens: runBudgetFields.outputTokens.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(defaults.outputTokens)),
    ),
    maxTokens: runBudgetFields.maxTokens.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(defaults.maxTokens)),
    ),
  }).check(callWithinBudget)

/**
 * What workflowd authorized for one run, sent on the control socket. workflowd sends a grant only
 * for a live run whose lease has recorded its Actions run; `notAfter` ends the run's authority as
 * workflowd's worker authorization does.
 */
export const CapabilityGrant = Schema.Struct({
  runId: Schema.String.check(Schema.isMaxLength(200)),
  leaseId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  recipientId: Schema.String,
  attempt: Schema.Int,
  repository: Schema.String,
  repositoryId: Schema.Int,
  repositoryName: Schema.String,
  installationId: Schema.Int,
  sourceSha: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  actionsRunId: Schema.Int,
  actionsAttempt: Schema.Int,
  deadline: Schema.Number,
  notAfter: Schema.Number,
  policy: SessionPolicy,
  /** Fixed by workflowd when it first authorizes the run; each grant of the run sends it again. */
  budget: RunBudget,
})
export type CapabilityGrant = typeof CapabilityGrant.Type

export interface ControlVerbSchemas<A, I, B, O> {
  readonly request: Schema.Codec<A, I>
  readonly response: Schema.Codec<B, O>
}
const schemas = <A, I, B, O>(entry: ControlVerbSchemas<A, I, B, O>) => entry

/**
 * The verbs of the control socket: the request and the answer of each. A new verb is one entry
 * here, its handler in the gateway's `controlVerbs`, and its call in workflowd's control client.
 */
export const controlProtocol = {
  /** Holds the grant of a live native run; a grant that differs from the one held revokes it. */
  authorize: schemas({
    request: Schema.Struct({ grant: CapabilityGrant }),
    response: Schema.Null,
  }),
  /** Revokes the run and ends its open streams at once. */
  revoke: schemas({ request: Schema.Struct({ runId: Schema.String }), response: Schema.Null }),
  /** Holds every grant sent and revokes each other run. */
  reconcile: schemas({
    request: Schema.Struct({ live: Schema.Array(CapabilityGrant) }),
    response: Schema.Null,
  }),
  /** Whether the runner of this Actions run and attempt holds a session. */
  sessionBound: schemas({
    request: Schema.Struct({
      runId: Schema.String,
      actionsRunId: Schema.Int,
      actionsAttempt: Schema.Int,
    }),
    response: Schema.Boolean,
  }),
}
export type ControlVerb = keyof typeof controlProtocol

/**
 * The migrations table of the gateway's store. workflowd refuses a database that holds it, and
 * the gateway refuses a database that holds any table but its own, each before a migration runs.
 */
export const gatewayMigrationsTable = "capability_gateway_migrations"

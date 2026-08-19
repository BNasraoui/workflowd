import { Schema } from "effect"

/**
 * The durable lifecycle condition of claimable work.
 *
 * This module owns the Work State vocabulary. Every durable work queue
 * (jobs, publications, commands, reconciliations) stores one of these values,
 * and every guard that names a state should name it from here rather than
 * repeating a string literal.
 *
 * The lifecycle is:
 *
 *   ready ──claim──▶ leased ──complete──▶ succeeded
 *     ▲                │
 *     │                ├──reschedule, attempts left──▶ retry_scheduled ──claim──▶ leased
 *     │                ├──reschedule, attempts spent─▶ failed
 *     │                ├──undecodable row───────────▶ data_error
 *     │                └──newer Generation or Review Request──▶ superseded
 *     └──requeue a failed fix, or an operator retry──────────────────────────┘
 *
 * A lease that expires does not change the state: the row stays `leased` and
 * becomes claimable again once `lease_until` has passed, which is why
 * `claimable` is a state set plus an expiry test rather than a state set alone.
 */
export const WorkState = Schema.Literal(
  "ready",
  "leased",
  "retry_scheduled",
  "succeeded",
  "failed",
  "superseded",
  "data_error",
)
export type WorkState = typeof WorkState.Type

/** States a worker may claim from directly, before considering lease expiry. */
export const claimableWorkStates = ["ready", "retry_scheduled"] as const satisfies ReadonlyArray<
  typeof WorkState.Type
>

/**
 * States that still owe an outcome. Work in these states is what supersession
 * cancels when a newer Generation or Review Request takes precedence; anything
 * else has already reached a durable outcome and is left as recorded history.
 */
export const unfinishedWorkStates = [
  "ready",
  "leased",
  "retry_scheduled",
] as const satisfies ReadonlyArray<typeof WorkState.Type>

/**
 * States that owe an outcome but will never produce one on their own. `failed`
 * spent its retry budget; `data_error` is quarantined because the row cannot be
 * interpreted as its declared kind of work. Neither becomes claimable again
 * without an operator, so both are what operational status counts.
 */
export const terminalFailureWorkStates = ["failed", "data_error"] as const satisfies ReadonlyArray<
  typeof WorkState.Type
>

/**
 * The one terminal failure an operator may put back on a queue. A `data_error`
 * row stays quarantined: requeueing it only re-quarantines it on the next
 * claim, because the record itself is what cannot be read.
 */
export const operatorRetryableWorkStates = ["failed"] as const satisfies ReadonlyArray<
  typeof WorkState.Type
>

/**
 * States a Publication loses to a newer Review Request. A Publication that
 * already succeeded is included: its comment is on the pull request, so the
 * newer Review Request must mark it no longer current. Generation supersession
 * uses `unfinishedWorkStates` instead and leaves sent comments alone.
 */
export const publicationStatesSupersededByReviewRequest = [
  ...unfinishedWorkStates,
  "succeeded",
] as const satisfies ReadonlyArray<typeof WorkState.Type>

/**
 * States whose Publication may still source Fix Work: the review comment is
 * either already sent or still on its way.
 */
export const fixSourcePublicationStates = publicationStatesSupersededByReviewRequest

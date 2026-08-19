import { Schema } from "effect"
import { GitObjectId } from "./identifiers"

export const ReviewTarget = Schema.Struct({
  baseSha: GitObjectId,
  baseRef: Schema.NonEmptyString,
  headSha: GitObjectId,
  headRef: Schema.NonEmptyString,
  headRepositoryFullName: Schema.NonEmptyString,
}).annotations({ parseOptions: { onExcessProperty: "error" } })

export type ReviewTarget = typeof ReviewTarget.Type

const identifyingFields = [
  "baseSha",
  "baseRef",
  "headSha",
  "headRef",
  "headRepositoryFullName",
] as const

/** Fails to compile while any Review Target field is missing from the list. */
type EveryIdentifyingField =
  Exclude<keyof ReviewTarget, (typeof identifyingFields)[number]> extends never
    ? typeof identifyingFields
    : never

/**
 * The fields that identify a Review Target. Anything comparing two targets
 * reads this list, so adding a field to the target extends every comparison
 * at once instead of leaving one of them behind.
 */
export const reviewTargetFieldNames: EveryIdentifyingField = identifyingFields

/**
 * Anything that carries the Review Target fields inline, whether it decodes
 * them as branded identifiers or reports them as plain GitHub strings.
 */
export type ReviewTargetIdentity = { readonly [K in keyof ReviewTarget]: string }

/** Two Review Targets are the same when every identifying field is the same. */
export const sameReviewTarget = (left: ReviewTargetIdentity, right: ReviewTargetIdentity) =>
  reviewTargetFieldNames.every((field) => left[field] === right[field])

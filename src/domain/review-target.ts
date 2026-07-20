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

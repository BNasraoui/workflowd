import { JSONSchema, Schema } from "effect"
import { GitObjectId } from "./identifiers"

const FixSummary = Schema.NonEmptyString.pipe(Schema.maxLength(4_000))
const exact = { parseOptions: { onExcessProperty: "error" as const } }

const CommitPrepared = Schema.TaggedStruct("CommitPrepared", {
  summary: FixSummary,
  commitSha: GitObjectId,
}).annotations(exact)

const NoChanges = Schema.TaggedStruct("NoChanges", {
  summary: FixSummary,
}).annotations(exact)

export const FixResult = Schema.Union(CommitPrepared, NoChanges)
export type FixResult = typeof FixResult.Type

export const FixResultJsonSchema = JSONSchema.make(FixResult)

import { Schema } from "effect"
import { GitObjectId } from "./identifiers"

const FixSummary = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_000)))
const exact = { parseOptions: { onExcessProperty: "error" as const } }

const CommitPrepared = Schema.TaggedStruct("CommitPrepared", {
  summary: FixSummary,
  commitSha: GitObjectId,
}).annotate(exact)

const NoChanges = Schema.TaggedStruct("NoChanges", {
  summary: FixSummary,
}).annotate(exact)

export const FixResult = Schema.Union([CommitPrepared, NoChanges])
export type FixResult = typeof FixResult.Type

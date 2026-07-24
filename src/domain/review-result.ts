import { Schema } from "effect"

const ReviewSummary = Schema.NonEmptyString.pipe(Schema.maxLength(4_000))
const FindingTitle = Schema.NonEmptyString.pipe(Schema.maxLength(200))
const FindingBody = Schema.NonEmptyString.pipe(Schema.maxLength(10_000))
const FindingPath = Schema.NonEmptyString.pipe(Schema.maxLength(1_024))

export const ReviewFinding = Schema.Struct({
  severity: Schema.Literal("critical", "high", "medium", "low"),
  title: FindingTitle,
  body: FindingBody,
  path: Schema.optional(FindingPath),
  line: Schema.optional(Schema.Int.pipe(Schema.positive())),
})
export type ReviewFinding = typeof ReviewFinding.Type

const Findings = Schema.Array(ReviewFinding).pipe(Schema.maxItems(50))

const PassedReviewResult = Schema.Struct({
  verdict: Schema.Literal("pass"),
  summary: ReviewSummary,
  findings: Findings.pipe(Schema.itemsCount(0)),
})

export const ChangesRequestedReviewResult = Schema.Struct({
  verdict: Schema.Literal("changes_requested"),
  summary: ReviewSummary,
  findings: Findings.pipe(Schema.minItems(1)),
})
export type ChangesRequestedReviewResult = typeof ChangesRequestedReviewResult.Type

export const ReviewResult = Schema.Union(PassedReviewResult, ChangesRequestedReviewResult)
export type ReviewResult = typeof ReviewResult.Type

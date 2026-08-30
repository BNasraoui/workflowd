import { Schema } from "effect"

const ReviewSummary = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_000)))
const FindingTitle = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))
const FindingBody = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(10_000)))
const FindingPath = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024)))

const AgentReviewFinding = Schema.Struct({
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  title: FindingTitle,
  body: FindingBody,
  path: Schema.optional(FindingPath),
  line: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
})

export const ReviewFinding = AgentReviewFinding.pipe(
  Schema.fieldsAssign({ provenance: Schema.optional(Schema.Literal("head_evidence")) }),
)
export type ReviewFinding = typeof ReviewFinding.Type

const Findings = Schema.Array(ReviewFinding).pipe(Schema.check(Schema.isMaxLength(50)))
const AgentFindings = Schema.Array(AgentReviewFinding).pipe(Schema.check(Schema.isMaxLength(50)))

const PassedReviewResult = Schema.Struct({
  verdict: Schema.Literal("pass"),
  summary: ReviewSummary,
  findings: Findings.pipe(Schema.check(Schema.isMaxLength(0))),
})

export const ChangesRequestedReviewResult = Schema.Struct({
  verdict: Schema.Literal("changes_requested"),
  summary: ReviewSummary,
  findings: Findings.pipe(Schema.check(Schema.isMinLength(1))),
})
export type ChangesRequestedReviewResult = typeof ChangesRequestedReviewResult.Type

export const ReviewResult = Schema.Union([PassedReviewResult, ChangesRequestedReviewResult])
export type ReviewResult = typeof ReviewResult.Type

export const AgentReviewResult = Schema.Union([
  Schema.Struct({
    verdict: Schema.Literal("pass"),
    summary: ReviewSummary,
    findings: AgentFindings.pipe(Schema.check(Schema.isMaxLength(0))),
  }),
  Schema.Struct({
    verdict: Schema.Literal("changes_requested"),
    summary: ReviewSummary,
    findings: AgentFindings.pipe(Schema.check(Schema.isMinLength(1))),
  }),
])

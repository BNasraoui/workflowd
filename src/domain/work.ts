import { Schema } from "effect"
import { FixResult } from "./fix-result"
import {
  AttemptNumber,
  GenerationNumber,
  JobId,
  PublicationId,
  PullRequestNumber,
  RepositoryId,
  ReviewRequestNumber,
  WorkerId,
} from "./identifiers"
import { ChangesRequestedReviewResult } from "./review-result"
import { ReviewTarget } from "./review-target"

const WorkFields = {
  id: JobId,
  installationId: Schema.Int.pipe(Schema.positive()),
  repositoryId: RepositoryId,
  repositoryFullName: Schema.NonEmptyString,
  pullRequestNumber: PullRequestNumber,
  author: Schema.NonEmptyString,
  target: ReviewTarget,
  generation: GenerationNumber,
  reviewRequestNumber: ReviewRequestNumber,
  workerId: WorkerId,
  attempt: AttemptNumber,
} as const

const exact = { parseOptions: { onExcessProperty: "error" as const } }

export const ReviewWork = Schema.TaggedStruct(
  "ReviewWork",
  WorkFields,
).annotations(exact)
export type ReviewWork = typeof ReviewWork.Type

export const FixWork = Schema.TaggedStruct("FixWork", {
  ...WorkFields,
  sourcePublicationId: PublicationId,
  review: ChangesRequestedReviewResult,
  checkpoint: Schema.optional(FixResult),
}).annotations(exact)
export type FixWork = typeof FixWork.Type

export const Work = Schema.Union(ReviewWork, FixWork)
export type Work = typeof Work.Type

import { Schema } from "effect"
import {
  AttemptNumber,
  GenerationNumber,
  PublicationId,
  PullRequestNumber,
  RepositoryId,
  ReviewRequestNumber,
} from "./identifiers"
import { ReviewResult } from "./review-result"
import { ReviewTarget } from "./review-target"

export const Publication = Schema.Struct({
  id: PublicationId,
  operationKey: Schema.NonEmptyString,
  installationId: Schema.Int.pipe(Schema.positive()),
  repositoryId: RepositoryId,
  repositoryFullName: Schema.NonEmptyString,
  pullRequestNumber: PullRequestNumber,
  target: ReviewTarget,
  generation: GenerationNumber,
  reviewRequestNumber: ReviewRequestNumber,
  review: ReviewResult,
  attempt: AttemptNumber,
})

export type Publication = typeof Publication.Type

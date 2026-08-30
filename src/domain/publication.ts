import { Schema } from "effect"
import { SessionReference } from "../agent-harness"
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
  installationId: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  repositoryId: RepositoryId,
  repositoryFullName: Schema.NonEmptyString,
  pullRequestNumber: PullRequestNumber,
  target: ReviewTarget,
  generation: GenerationNumber,
  reviewRequestNumber: ReviewRequestNumber,
  review: ReviewResult,
  sessionReferenceId: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  ),
  sessionReference: Schema.optional(SessionReference),
  sessionExecutionState: Schema.optional(
    Schema.Literals(["launch_intent", "session_ready", "succeeded", "failed", "superseded"]),
  ),
  attempt: AttemptNumber,
})

export type Publication = typeof Publication.Type

import { Schema } from "effect"

const PositiveInt = Schema.Int.pipe(Schema.positive())

export const RepositoryId = PositiveInt.pipe(Schema.brand("RepositoryId"))
export type RepositoryId = typeof RepositoryId.Type

export const PullRequestNumber = PositiveInt.pipe(
  Schema.brand("PullRequestNumber"),
)
export type PullRequestNumber = typeof PullRequestNumber.Type

export const JobId = PositiveInt.pipe(Schema.brand("JobId"))
export type JobId = typeof JobId.Type

export const PublicationId = PositiveInt.pipe(Schema.brand("PublicationId"))
export type PublicationId = typeof PublicationId.Type

export const GenerationNumber = PositiveInt.pipe(
  Schema.brand("GenerationNumber"),
)
export type GenerationNumber = typeof GenerationNumber.Type

export const ReviewRequestNumber = PositiveInt.pipe(
  Schema.brand("ReviewRequestNumber"),
)
export type ReviewRequestNumber = typeof ReviewRequestNumber.Type

export const AttemptNumber = PositiveInt.pipe(Schema.brand("AttemptNumber"))
export type AttemptNumber = typeof AttemptNumber.Type

export const WorkerId = Schema.NonEmptyString.pipe(Schema.brand("WorkerId"))
export type WorkerId = typeof WorkerId.Type

export const GitObjectId = Schema.String.pipe(
  Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
  Schema.brand("GitObjectId"),
)
export type GitObjectId = typeof GitObjectId.Type

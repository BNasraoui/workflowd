import { Effect, Option, Schema } from "effect"
import {
  AttemptNumber,
  GenerationNumber,
  GitObjectId,
  JobId,
  PublicationId,
  PullRequestNumber,
  RepositoryId,
  ReviewRequestNumber,
  WorkerId,
} from "../domain/identifiers"
import { FixResult } from "../domain/fix-result"
import { Publication } from "../domain/publication"
import { ChangesRequestedReviewResult, ReviewResult } from "../domain/review-result"
import { FixWork, ReviewWork, type Work } from "../domain/work"
import { StoreDataError } from "./errors"
import type { AgentCommand, PullRequestReconciliation } from "./model"

const PositiveInt = Schema.Int.pipe(Schema.positive())
const RowId = Schema.Struct({ id: Schema.Int })
const json = <S extends Schema.Schema.Any>(schema: S) => Schema.parseJson(schema)
const column = <K extends string, S extends Schema.Schema.Any>(key: K, schema: S) =>
  Schema.propertySignature(schema).pipe(Schema.fromKey(key))

const workRowFields = {
  id: JobId,
  installationId: column("installation_id", PositiveInt),
  repositoryId: column("repository_id", RepositoryId),
  repositoryFullName: column("repository_full_name", Schema.NonEmptyString),
  pullRequestNumber: column("pull_request_number", PullRequestNumber),
  author: Schema.NonEmptyString,
  baseRef: column("base_ref", Schema.NonEmptyString),
  baseSha: column("base_sha", GitObjectId),
  expectedHeadSha: column("expected_head_sha", GitObjectId),
  headRef: column("head_ref", Schema.NonEmptyString),
  headRepositoryFullName: column("head_repository_full_name", Schema.NonEmptyString),
  generation: GenerationNumber,
  reviewRequestNumber: column("review_request_number", ReviewRequestNumber),
  workerId: column("lease_owner", WorkerId),
  attempt: column("attempts", AttemptNumber),
} as const

const workFields = (work: Work) => ({
  id: work.id,
  installationId: work.installationId,
  repositoryId: work.repositoryId,
  repositoryFullName: work.repositoryFullName,
  pullRequestNumber: work.pullRequestNumber,
  author: work.author,
  baseRef: work.target.baseRef,
  baseSha: work.target.baseSha,
  expectedHeadSha: work.target.headSha,
  headRef: work.target.headRef,
  headRepositoryFullName: work.target.headRepositoryFullName,
  generation: work.generation,
  reviewRequestNumber: work.reviewRequestNumber,
  workerId: work.workerId,
  attempt: work.attempt,
})

const toWork = (row: typeof ReviewJobRow.Type | typeof FixJobRow.Type) => ({
  id: row.id,
  installationId: row.installationId,
  repositoryId: row.repositoryId,
  repositoryFullName: row.repositoryFullName,
  pullRequestNumber: row.pullRequestNumber,
  author: row.author,
  target: {
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    headSha: row.expectedHeadSha,
    headRef: row.headRef,
    headRepositoryFullName: row.headRepositoryFullName,
  },
  generation: row.generation,
  reviewRequestNumber: row.reviewRequestNumber,
  workerId: row.workerId,
  attempt: row.attempt,
})

const ReviewJobRow = Schema.Struct({
  ...workRowFields,
  kind: Schema.Literal("review"),
  publicationId: column("publication_id", Schema.Null),
  review: column("review_json", Schema.Null),
  fixResult: column("fix_result_json", Schema.Null),
})
const FixJobRow = Schema.Struct({
  ...workRowFields,
  kind: Schema.Literal("fix"),
  publicationId: column("publication_id", PublicationId),
  review: column("review_json", json(ChangesRequestedReviewResult)),
  fixResult: column("fix_result_json", Schema.NullOr(json(FixResult))),
})

const ReviewWorkRow = Schema.transform(ReviewJobRow, ReviewWork, {
  strict: true,
  decode: (row) => ({ _tag: "ReviewWork" as const, ...toWork(row) }),
  encode: (_, work) => ({
    ...workFields(work),
    kind: "review" as const,
    publicationId: null,
    review: null,
    fixResult: null,
  }),
})
const FixWorkRow = Schema.transform(FixJobRow, FixWork, {
  strict: true,
  decode: (row) => ({
    _tag: "FixWork" as const,
    ...toWork(row),
    sourcePublicationId: row.publicationId,
    review: row.review,
    checkpoint: row.fixResult ?? undefined,
  }),
  encode: (_, work) => ({
    ...workFields(work),
    kind: "fix" as const,
    publicationId: work.sourcePublicationId,
    review: work.review,
    fixResult: work.checkpoint ?? null,
  }),
})
const WorkRow = Schema.Union(ReviewWorkRow, FixWorkRow)

const PublicationStorageRow = Schema.Struct({
  id: PublicationId,
  operationKey: column("operation_key", Schema.NonEmptyString),
  installationId: column("installation_id", PositiveInt),
  repositoryId: column("repository_id", RepositoryId),
  repositoryFullName: column("repository_full_name", Schema.NonEmptyString),
  pullRequestNumber: column("pull_request_number", PullRequestNumber),
  baseRef: column("base_ref", Schema.NonEmptyString),
  baseSha: column("base_sha", GitObjectId),
  expectedHeadSha: column("expected_head_sha", GitObjectId),
  headRef: column("head_ref", Schema.NonEmptyString),
  headRepositoryFullName: column("head_repository_full_name", Schema.NonEmptyString),
  generation: GenerationNumber,
  reviewRequestNumber: column("review_request_number", ReviewRequestNumber),
  review: column("review_json", json(ReviewResult)),
  sessionReferenceId: column("session_reference_id", Schema.NullOr(Schema.NonEmptyString)),
  attempt: column("attempts", AttemptNumber),
})
const PublicationRow = Schema.transform(PublicationStorageRow, Publication, {
  strict: true,
  decode: (row) => ({
    id: row.id,
    operationKey: row.operationKey,
    installationId: row.installationId,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    pullRequestNumber: row.pullRequestNumber,
    target: {
      baseRef: row.baseRef,
      baseSha: row.baseSha,
      headSha: row.expectedHeadSha,
      headRef: row.headRef,
      headRepositoryFullName: row.headRepositoryFullName,
    },
    generation: row.generation,
    reviewRequestNumber: row.reviewRequestNumber,
    review: row.review,
    ...(row.sessionReferenceId === null ? {} : { sessionReferenceId: row.sessionReferenceId }),
    attempt: row.attempt,
  }),
  encode: (_, publication) => ({
    id: publication.id,
    operationKey: publication.operationKey,
    installationId: publication.installationId,
    repositoryId: publication.repositoryId,
    repositoryFullName: publication.repositoryFullName,
    pullRequestNumber: publication.pullRequestNumber,
    baseRef: publication.target.baseRef,
    baseSha: publication.target.baseSha,
    expectedHeadSha: publication.target.headSha,
    headRef: publication.target.headRef,
    headRepositoryFullName: publication.target.headRepositoryFullName,
    generation: publication.generation,
    reviewRequestNumber: publication.reviewRequestNumber,
    review: publication.review,
    sessionReferenceId: publication.sessionReferenceId ?? null,
    attempt: publication.attempt,
  }),
})
const CommandRow = Schema.Struct({
  id: PositiveInt,
  command: Schema.Literal("fix", "review", "status"),
  commentId: column("comment_id", PositiveInt),
  commenter: Schema.NonEmptyString,
  installationId: column("installation_id", PositiveInt),
  repositoryId: column("repository_id", PositiveInt),
  repositoryFullName: column("repository_full_name", Schema.NonEmptyString),
  pullRequestNumber: column("pull_request_number", PositiveInt),
  attempts: Schema.Int.pipe(Schema.positive()),
})
const ReconciliationRow = Schema.Struct({
  id: PositiveInt,
  installationId: column("installation_id", PositiveInt),
  repositoryId: column("repository_id", PositiveInt),
  repositoryFullName: column("repository_full_name", Schema.NonEmptyString),
  pullRequestNumber: column("pull_request_number", PositiveInt),
  attempts: Schema.Int.pipe(Schema.positive()),
})
const PublicationReviewRow = Schema.Struct({
  reviewJobId: column("review_job_id", JobId),
  id: column("publication_id", PublicationId),
  review: column("review_json", json(ReviewResult)),
})

const decodeRow =
  <A, I, R>(schema: Schema.Schema<A, I, R>, record: StoreDataError["record"]) =>
  (row: unknown): Effect.Effect<A, StoreDataError, R> =>
    Schema.decodeUnknown(schema)(row).pipe(
      Effect.mapError((error) => {
        const message = String(error)
        return new StoreDataError({
          record,
          recordId: Option.getOrElse(
            Schema.decodeUnknownOption(RowId)(row).pipe(Option.map(({ id }) => id)),
            () => 0,
          ),
          field: message.includes("review_json")
            ? "review_json"
            : message.includes("fix_result_json")
              ? "fix_result_json"
              : "row",
          message,
        })
      }),
    )

export const decodeCommandRow: (row: unknown) => Effect.Effect<AgentCommand, StoreDataError> =
  decodeRow(CommandRow, "command")
export const decodeJobRow = decodeRow(WorkRow, "job")
export const decodePublicationRow = decodeRow(PublicationRow, "publication")
export const decodePublicationReviewRow = decodeRow(PublicationReviewRow, "publication")
export const decodeReconciliationRow: (
  row: unknown,
) => Effect.Effect<PullRequestReconciliation, StoreDataError> = decodeRow(
  ReconciliationRow,
  "reconciliation",
)

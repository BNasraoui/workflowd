import { Effect, Option, Schema, SchemaTransformation } from "effect"
import { SessionReference } from "../agent-harness"
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

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const RowId = Schema.Struct({ id: Schema.Int })
const json = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(schema)

const workRowFields = {
  id: JobId,
  installationId: PositiveInt,
  repositoryId: RepositoryId,
  repositoryFullName: Schema.NonEmptyString,
  pullRequestNumber: PullRequestNumber,
  author: Schema.NonEmptyString,
  baseRef: Schema.NonEmptyString,
  baseSha: GitObjectId,
  expectedHeadSha: GitObjectId,
  headRef: Schema.NonEmptyString,
  headRepositoryFullName: Schema.NonEmptyString,
  generation: GenerationNumber,
  reviewRequestNumber: ReviewRequestNumber,
  workerId: WorkerId,
  attempt: AttemptNumber,
} as const

const workRowKeys = {
  installationId: "installation_id",
  repositoryId: "repository_id",
  repositoryFullName: "repository_full_name",
  pullRequestNumber: "pull_request_number",
  baseRef: "base_ref",
  baseSha: "base_sha",
  expectedHeadSha: "expected_head_sha",
  headRef: "head_ref",
  headRepositoryFullName: "head_repository_full_name",
  reviewRequestNumber: "review_request_number",
  workerId: "lease_owner",
  attempt: "attempts",
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
  publicationId: Schema.Null,
  review: Schema.Null,
  fixResult: Schema.Null,
}).pipe(
  Schema.encodeKeys({
    ...workRowKeys,
    publicationId: "publication_id",
    review: "review_json",
    fixResult: "fix_result_json",
  }),
)
const FixJobRow = Schema.Struct({
  ...workRowFields,
  kind: Schema.Literal("fix"),
  publicationId: PublicationId,
  review: json(ChangesRequestedReviewResult),
  fixResult: Schema.NullOr(json(FixResult)),
}).pipe(
  Schema.encodeKeys({
    ...workRowKeys,
    publicationId: "publication_id",
    review: "review_json",
    fixResult: "fix_result_json",
  }),
)

const ReviewWorkRow = ReviewJobRow.pipe(
  Schema.decodeTo(
    Schema.toType(ReviewWork),
    SchemaTransformation.transform<(typeof ReviewWork)["Type"], (typeof ReviewJobRow)["Type"]>({
      decode: (row) => ({ _tag: "ReviewWork" as const, ...toWork(row) }),
      encode: (work) => ({
        ...workFields(work),
        kind: "review" as const,
        publicationId: null,
        review: null,
        fixResult: null,
      }),
    }),
  ),
)
const FixWorkRow = FixJobRow.pipe(
  Schema.decodeTo(
    Schema.toType(FixWork),
    SchemaTransformation.transform<(typeof FixWork)["Type"], (typeof FixJobRow)["Type"]>({
      decode: (row) => ({
        _tag: "FixWork" as const,
        ...toWork(row),
        sourcePublicationId: row.publicationId,
        review: row.review,
        checkpoint: row.fixResult ?? undefined,
      }),
      encode: (work) => ({
        ...workFields(work),
        kind: "fix" as const,
        publicationId: work.sourcePublicationId,
        review: work.review,
        fixResult: work.checkpoint ?? null,
      }),
    }),
  ),
)
const WorkRow = Schema.Union([ReviewWorkRow, FixWorkRow])

const PublicationStorageRow = Schema.Struct({
  id: PublicationId,
  operationKey: Schema.NonEmptyString,
  installationId: PositiveInt,
  repositoryId: RepositoryId,
  repositoryFullName: Schema.NonEmptyString,
  pullRequestNumber: PullRequestNumber,
  baseRef: Schema.NonEmptyString,
  baseSha: GitObjectId,
  expectedHeadSha: GitObjectId,
  headRef: Schema.NonEmptyString,
  headRepositoryFullName: Schema.NonEmptyString,
  generation: GenerationNumber,
  reviewRequestNumber: ReviewRequestNumber,
  review: json(ReviewResult),
  sessionReferenceId: Schema.NullOr(Schema.NonEmptyString),
  sessionReference: Schema.NullOr(json(SessionReference)),
  sessionExecutionState: Schema.NullOr(
    Schema.Literals(["launch_intent", "session_ready", "succeeded", "failed", "superseded"]),
  ),
  attempt: AttemptNumber,
}).pipe(
  Schema.encodeKeys({
    operationKey: "operation_key",
    installationId: "installation_id",
    repositoryId: "repository_id",
    repositoryFullName: "repository_full_name",
    pullRequestNumber: "pull_request_number",
    baseRef: "base_ref",
    baseSha: "base_sha",
    expectedHeadSha: "expected_head_sha",
    headRef: "head_ref",
    headRepositoryFullName: "head_repository_full_name",
    reviewRequestNumber: "review_request_number",
    review: "review_json",
    sessionReferenceId: "session_reference_id",
    sessionReference: "session_reference_json",
    sessionExecutionState: "session_execution_state",
    attempt: "attempts",
  }),
)
const PublicationRow = PublicationStorageRow.pipe(
  Schema.decodeTo(
    Schema.toType(Publication),
    SchemaTransformation.transform<
      (typeof Publication)["Type"],
      (typeof PublicationStorageRow)["Type"]
    >({
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
        ...(row.sessionReference === null ? {} : { sessionReference: row.sessionReference }),
        ...(row.sessionExecutionState === null
          ? {}
          : { sessionExecutionState: row.sessionExecutionState }),
        attempt: row.attempt,
      }),
      encode: (publication) => ({
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
        sessionReference: publication.sessionReference ?? null,
        sessionExecutionState: publication.sessionExecutionState ?? null,
        attempt: publication.attempt,
      }),
    }),
  ),
)
const CommandRow = Schema.Struct({
  id: PositiveInt,
  command: Schema.Literals(["fix", "review", "status"]),
  commentId: PositiveInt,
  commenter: Schema.NonEmptyString,
  installationId: PositiveInt,
  repositoryId: PositiveInt,
  repositoryFullName: Schema.NonEmptyString,
  pullRequestNumber: PositiveInt,
  attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
}).pipe(
  Schema.encodeKeys({
    commentId: "comment_id",
    installationId: "installation_id",
    repositoryId: "repository_id",
    repositoryFullName: "repository_full_name",
    pullRequestNumber: "pull_request_number",
  }),
)
const ReconciliationRow = Schema.Struct({
  id: PositiveInt,
  installationId: PositiveInt,
  repositoryId: PositiveInt,
  repositoryFullName: Schema.NonEmptyString,
  pullRequestNumber: PositiveInt,
  attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
}).pipe(
  Schema.encodeKeys({
    installationId: "installation_id",
    repositoryId: "repository_id",
    repositoryFullName: "repository_full_name",
    pullRequestNumber: "pull_request_number",
  }),
)
const PublicationReviewRow = Schema.Struct({
  reviewJobId: JobId,
  id: PublicationId,
  review: json(ReviewResult),
}).pipe(
  Schema.encodeKeys({
    reviewJobId: "review_job_id",
    id: "publication_id",
    review: "review_json",
  }),
)
const AgentSessionReferenceRow = Schema.Struct({
  sessionReference: json(SessionReference),
}).pipe(Schema.encodeKeys({ sessionReference: "session_reference_json" }))

const decodeRow =
  <A, I, R>(schema: Schema.Codec<A, I, R>, record: StoreDataError["record"]) =>
  (row: unknown): Effect.Effect<A, StoreDataError, R> =>
    Schema.decodeUnknownEffect(schema)(row).pipe(
      Effect.mapError((error) => {
        const raw = String(error)
        const column =
          raw.includes("review_json") || raw.includes('["review"]')
            ? "review_json"
            : raw.includes("fix_result_json") || raw.includes('["fixResult"]')
              ? "fix_result_json"
              : raw.includes('["sessionReference"]')
                ? "session_reference_json"
                : undefined
        return new StoreDataError({
          record,
          recordId: Option.getOrElse(
            Schema.decodeUnknownOption(RowId)(row).pipe(Option.map(({ id }) => id)),
            () => 0,
          ),
          field: column === "review_json" || column === "fix_result_json" ? column : "row",
          message: column === undefined ? raw : `${column}: ${raw}`,
        })
      }),
    )

export const decodeCommandRow: (row: unknown) => Effect.Effect<AgentCommand, StoreDataError> =
  decodeRow(CommandRow, "command")
export const decodeAgentSessionReferenceRow = decodeRow(AgentSessionReferenceRow, "agent_execution")
export const decodeJobRow = decodeRow(WorkRow, "job")
export const decodePublicationRow = decodeRow(PublicationRow, "publication")
export const decodePublicationReviewRow = decodeRow(PublicationReviewRow, "publication")
export const decodeReconciliationRow: (
  row: unknown,
) => Effect.Effect<PullRequestReconciliation, StoreDataError> = decodeRow(
  ReconciliationRow,
  "reconciliation",
)

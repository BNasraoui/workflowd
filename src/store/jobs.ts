import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect } from "effect"
import type { Work } from "../domain/work"
import { decodeJobRow } from "./codecs"
import type { WorkflowStorePort } from "./contracts"
import { makeCurrentnessPolicy } from "./currentness"
import { SqlLeaseQueue } from "./lease"
import type { makeSharedStoreOperations } from "./shared"

type JobOperations = Pick<
  WorkflowStorePort,
  | "claimNextJob"
  | "completeFixJob"
    | "completeReviewJob"
    | "disableFixJob"
    | "isJobCurrent"
  | "recordFixResult"
  | "rescheduleJob"
  | "shouldCancelJob"
>

export function makeJobOperations(
  sql: SqlClient,
  shared: Pick<
    ReturnType<typeof makeSharedStoreOperations>,
    "enqueueFixFromReview"
  >,
): JobOperations {
  const currentness = makeCurrentnessPolicy(sql)
  const queue = new SqlLeaseQueue<Work>(sql, {
    table: "jobs",
    claimableId: currentness.jobClaimCandidate,
    returning: sql.literal(`
      id,
      kind,
      installation_id,
      repository_id,
      repository_full_name,
      pull_request_number,
      author,
      base_ref,
      base_sha,
      expected_head_sha,
      head_ref,
      head_repository_full_name,
      generation,
      review_request_number,
      publication_id,
      review_json,
      fix_result_json,
      lease_owner,
      attempts
    `),
    decode: decodeJobRow,
  })

  return {
    claimNextJob: (input) => queue.claim(input),
    isJobCurrent: (jobId, workerId, now) =>
      sql<{ readonly current: number }>`
        SELECT 1 AS current
        FROM jobs AS candidate
        WHERE candidate.id = ${jobId}
        AND candidate.kind = 'fix'
        AND candidate.state = 'leased'
        AND candidate.cancel_requested = FALSE
        AND candidate.lease_owner = ${workerId}
        AND candidate.lease_until > ${now.toISOString()}
        AND ${currentness.currentPublication}
        AND ${currentness.latestReviewRequest}
      `.pipe(Effect.map((rows) => rows.length > 0)),
    disableFixJob: (input) =>
      sql<{ readonly id: number }>`
        UPDATE jobs
        SET
          state = 'superseded',
          cancel_requested = TRUE,
          lease_owner = NULL,
          lease_until = NULL,
          last_error = 'Fix Work disabled',
          updated_at = ${input.disabledAt.toISOString()}
        WHERE id = ${input.jobId}
        AND kind = 'fix'
        AND state = 'leased'
        AND lease_owner = ${input.workerId}
        AND lease_until > ${input.disabledAt.toISOString()}
        RETURNING id
      `.pipe(
        Effect.map((rows) => (rows.length === 0 ? "stale" : "disabled")),
      ),
    completeFixJob: (input) =>
      sql<{ readonly id: number }>`
        UPDATE jobs AS candidate
        SET
          state = 'succeeded',
          lease_owner = NULL,
          lease_until = NULL,
          last_error = NULL,
          updated_at = ${input.completedAt.toISOString()}
        WHERE candidate.id = ${input.jobId}
        AND candidate.kind = 'fix'
        AND candidate.state = 'leased'
        AND candidate.cancel_requested = FALSE
        AND candidate.lease_owner = ${input.workerId}
        AND candidate.lease_until > ${input.completedAt.toISOString()}
        AND ${currentness.currentJob}
        AND ${currentness.latestReviewRequest}
        RETURNING id
      `.pipe(
        Effect.map((rows) => (rows.length === 0 ? "stale" : "completed")),
      ),
    completeReviewJob: (input) =>
      Effect.gen(function* () {
        const timestamp = input.completedAt.toISOString()
        const jobs = yield* sql<{
          readonly installation_id: number
          readonly repository_id: number
          readonly repository_full_name: string
          readonly pull_request_number: number
          readonly base_ref: string
          readonly base_sha: string
          readonly expected_head_sha: string
          readonly head_ref: string
          readonly head_repository_full_name: string
          readonly generation: number
          readonly review_request_number: number
        }>`
          UPDATE jobs AS candidate
          SET
            state = 'succeeded',
            lease_owner = NULL,
            lease_until = NULL,
            last_error = NULL,
            updated_at = ${timestamp}
          WHERE candidate.id = ${input.jobId}
          AND candidate.kind = 'review'
          AND candidate.state = 'leased'
          AND candidate.cancel_requested = FALSE
          AND candidate.lease_owner = ${input.workerId}
          AND candidate.lease_until > ${timestamp}
          AND ${currentness.currentJob}
          AND ${currentness.latestReviewRequest}
          RETURNING
            installation_id,
            repository_id,
            repository_full_name,
            pull_request_number,
            base_ref,
            base_sha,
            expected_head_sha,
            head_ref,
            head_repository_full_name,
            generation,
            review_request_number
        `
        const job = jobs[0]
        if (job === undefined) return "stale" as const

        const operationKey =
          job.review_request_number === 1
            ? `review:${job.repository_id}:${job.pull_request_number}:${job.generation}`
            : `review:${job.repository_id}:${job.pull_request_number}:${job.generation}:${job.review_request_number}`
        yield* sql<{ readonly id: number }>`
          INSERT INTO publications (
            operation_key,
            installation_id,
            repository_id,
            repository_full_name,
            pull_request_number,
            base_ref,
            base_sha,
            expected_head_sha,
            head_ref,
            head_repository_full_name,
            generation,
            review_request_number,
            review_json,
            state,
            run_at,
            created_at,
            updated_at
          ) VALUES (
            ${operationKey},
            ${job.installation_id},
            ${job.repository_id},
            ${job.repository_full_name},
            ${job.pull_request_number},
            ${job.base_ref},
            ${job.base_sha},
            ${job.expected_head_sha},
            ${job.head_ref},
            ${job.head_repository_full_name},
            ${job.generation},
            ${job.review_request_number},
            ${JSON.stringify(input.review)},
            'ready',
            ${timestamp},
            ${timestamp},
            ${timestamp}
          )
          RETURNING id
        `
        if (input.autoFix) {
          yield* shared.enqueueFixFromReview({
            headRepositoryFullName: job.head_repository_full_name,
            reviewJobId: input.jobId,
            requestedAt: timestamp,
            repositoryFullName: job.repository_full_name,
            review: input.review,
            requeueFailed: false,
          })
        }
        return "completed" as const
      }).pipe(sql.withTransaction),
    recordFixResult: (input) =>
      sql<{ readonly id: number }>`
        UPDATE jobs
        SET
          fix_result_json = ${JSON.stringify(input.result)},
          updated_at = ${input.recordedAt.toISOString()}
        WHERE id = ${input.jobId}
        AND kind = 'fix'
        AND state = 'leased'
        AND lease_owner = ${input.workerId}
        AND lease_until > ${input.recordedAt.toISOString()}
        AND fix_result_json IS NULL
        RETURNING id
      `.pipe(
        Effect.map((rows) => (rows.length === 0 ? "stale" : "recorded")),
      ),
    rescheduleJob: (input) => queue.reschedule({ ...input, id: input.jobId }),
    shouldCancelJob: (jobId, workerId, now) =>
      sql<{ readonly current: number }>`
        SELECT 1 AS current
        FROM jobs AS candidate
        WHERE candidate.id = ${jobId}
        AND candidate.state = 'leased'
        AND candidate.cancel_requested = FALSE
        AND candidate.lease_owner = ${workerId}
        AND candidate.lease_until > ${now.toISOString()}
        AND ${currentness.currentJob}
        AND ${currentness.latestReviewRequest}
      `.pipe(Effect.map((rows) => rows.length === 0)),
  } satisfies JobOperations
}

import type { SqlClient } from "@effect/sql/SqlClient"
import { SqlError } from "@effect/sql/SqlError"
import { Effect, Schema } from "effect"
import { AgentLaunchIntentEnvelope, AgentOutputEnvelope } from "../agent-payload"
import { AgentLaunchIntentSchema } from "../agent-harness"
import { FixResult } from "../domain/fix-result"
import { ReviewResult } from "../domain/review-result"
import type { Work } from "../domain/work"
import { decodeAgentSessionReferenceRow, decodeJobRow } from "./codecs"
import type { WorkflowStorePort } from "./contracts"
import { makeCurrentnessPolicy } from "./currentness"
import { SqlLeaseQueue } from "./lease"
import type { makeSharedStoreOperations } from "./shared"
import type { CompleteReviewJobInput, RecordFixResultInput } from "./model"

type JobOperations = Pick<
  WorkflowStorePort,
  | "claimExpiredAgentSession"
  | "claimNextJob"
  | "completeAgentReviewJob"
  | "completeFixJob"
  | "completeReviewJob"
  | "disableFixJob"
  | "isJobCurrent"
  | "isTrustedBranchPublication"
  | "recordAgentFixResult"
  | "recordAgentLaunchIntent"
  | "recordAgentSessionCleanupFailure"
  | "recordAgentSessionReference"
  | "recordFixResult"
  | "rescheduleJob"
  | "shouldCancelJob"
  | "supersedeAgentSession"
>

const encodeDurablePayload = <A, I>(
  schema: Schema.Schema<A, I, never>,
  envelope: Schema.Schema<unknown>,
  value: unknown,
) =>
  Schema.decodeUnknown(envelope)(value).pipe(
    Effect.flatMap(() => Schema.decodeUnknown(schema)(value)),
    Effect.map((decoded) => ({ decoded, json: JSON.stringify(decoded) })),
    Effect.mapError(
      (cause) => new SqlError({ cause, message: "Agent payload exceeds its durable envelope" }),
    ),
  )

export function makeJobOperations(
  sql: SqlClient,
  shared: Pick<ReturnType<typeof makeSharedStoreOperations>, "enqueueFixFromReview">,
): JobOperations {
  const currentness = makeCurrentnessPolicy(sql)
  const queue = new SqlLeaseQueue<Work>(sql, {
    table: "jobs",
    beforeClaim: (claimedAt) =>
      sql`
        UPDATE agent_executions
        SET state = 'superseded', updated_at = ${claimedAt}
        WHERE state = 'launch_intent'
        AND job_id IN (
          SELECT id FROM jobs
          WHERE state = 'leased' AND lease_until <= ${claimedAt}
        )
      `.pipe(Effect.asVoid),
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

  const completeReviewJob = (input: CompleteReviewJobInput) =>
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
      const sessionReferenceId = "sessionReferenceId" in input ? input.sessionReferenceId : null
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
          session_reference_id,
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
          ${sessionReferenceId},
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
    })

  const recordFixResult = (input: RecordFixResultInput) =>
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
    `.pipe(Effect.map((rows) => (rows.length === 0 ? ("stale" as const) : ("recorded" as const))))

  return {
    isTrustedBranchPublication: (input) =>
      sql<{ readonly trusted: number }>`
        SELECT EXISTS (
          SELECT 1
          FROM jobs AS candidate
          WHERE candidate.id = ${input.jobId}
          AND candidate.kind = 'fix'
          AND candidate.state = 'succeeded'
          AND CAST(candidate.repository_id AS TEXT) = ${input.repositoryId}
          AND candidate.repository_full_name = ${input.repositoryFullName}
          AND candidate.head_repository_full_name = ${input.repositoryFullName}
          AND candidate.head_ref = ${input.headRef}
          AND json_extract(candidate.fix_result_json, '$._tag') = 'CommitPrepared'
          AND json_extract(candidate.fix_result_json, '$.commitSha') = ${input.commitSha}
        ) AS trusted
      `.pipe(Effect.map((rows) => rows[0]?.trusted === 1)),
    claimExpiredAgentSession: (input) =>
      Effect.gen(function* () {
        const claimedAt = input.now.toISOString()
        const claimedUntil = new Date(input.now.getTime() + input.leaseDurationMs).toISOString()
        while (true) {
          const rows = yield* sql<{
            readonly session_reference_id: string
            readonly session_reference_json: string
          }>`
            UPDATE agent_executions
            SET
              cleanup_lease_owner = ${input.workerId},
              cleanup_lease_until = ${claimedUntil},
              cleanup_attempts = cleanup_attempts + 1,
              updated_at = ${claimedAt}
            WHERE session_reference_id = (
              SELECT execution.session_reference_id
              FROM agent_executions AS execution
              JOIN jobs AS candidate ON candidate.id = execution.job_id
              WHERE execution.state = 'session_ready'
              AND execution.cleanup_disposition IS NULL
              AND (
                execution.cleanup_lease_until IS NULL
                OR execution.cleanup_lease_until <= ${claimedAt}
              )
              AND (
                candidate.state <> 'leased'
                OR candidate.lease_until <= ${claimedAt}
              )
              ORDER BY COALESCE(candidate.lease_until, execution.updated_at) ASC, candidate.id ASC
              LIMIT 1
            )
            RETURNING session_reference_id, session_reference_json
          `
          const row = rows[0]
          if (row === undefined) return null
          const decoded = yield* Effect.either(decodeAgentSessionReferenceRow(row))
          const mismatch =
            decoded._tag === "Right" &&
            decoded.right.sessionReference.sessionReferenceId !== row.session_reference_id
          if (decoded._tag === "Right" && !mismatch) return decoded.right.sessionReference

          const message =
            decoded._tag === "Left"
              ? decoded.left.message
              : `Stored SessionReference identity ${decoded.right.sessionReference.sessionReferenceId} does not match ${row.session_reference_id}`
          yield* sql`
            UPDATE agent_executions
            SET cleanup_disposition = 'data_error',
              cleanup_last_error = ${message.slice(0, 8_192)},
              cleanup_lease_owner = NULL,
              cleanup_lease_until = NULL,
              updated_at = ${claimedAt}
            WHERE session_reference_id = ${row.session_reference_id}
            AND state = 'session_ready'
            AND cleanup_lease_owner = ${input.workerId}
          `
        }
      }).pipe(sql.withTransaction),
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
      Effect.gen(function* () {
        const timestamp = input.disabledAt.toISOString()
        const rows = yield* sql<{ readonly id: number }>`
          UPDATE jobs
          SET
            state = 'superseded',
            cancel_requested = TRUE,
            lease_owner = NULL,
            lease_until = NULL,
            last_error = 'Fix Work disabled',
            updated_at = ${timestamp}
          WHERE id = ${input.jobId}
          AND kind = 'fix'
          AND state = 'leased'
          AND lease_owner = ${input.workerId}
          AND lease_until > ${timestamp}
          RETURNING id
        `
        if (rows.length === 0) return "stale" as const
        yield* sql`
          UPDATE agent_executions
          SET state = 'superseded', updated_at = ${timestamp}
          WHERE job_id = ${input.jobId}
          AND state = 'launch_intent'
        `
        return "disabled" as const
      }).pipe(sql.withTransaction),
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
      `.pipe(Effect.map((rows) => (rows.length === 0 ? "stale" : "completed"))),
    completeReviewJob: (input) => completeReviewJob(input).pipe(sql.withTransaction),
    completeAgentReviewJob: (input) =>
      Effect.gen(function* () {
        const timestamp = input.completedAt.toISOString()
        const executions = yield* sql<{ readonly session_reference_id: string }>`
          SELECT execution.session_reference_id
          FROM agent_executions AS execution
          JOIN jobs AS candidate ON candidate.id = execution.job_id
          WHERE execution.session_reference_id = ${input.sessionReferenceId}
          AND execution.job_id = ${input.jobId}
          AND execution.state = 'session_ready'
          AND execution.attempt = candidate.attempts
          AND candidate.kind = 'review'
          AND candidate.state = 'leased'
          AND candidate.cancel_requested = FALSE
          AND candidate.lease_owner = ${input.workerId}
          AND candidate.lease_until > ${timestamp}
          AND ${currentness.currentJob}
          AND ${currentness.latestReviewRequest}
        `
        if (executions.length === 0) return "stale" as const
        const output = yield* encodeDurablePayload(ReviewResult, AgentOutputEnvelope, input.review)
        const completed = yield* completeReviewJob({ ...input, review: output.decoded })
        if (completed === "stale") return completed
        yield* sql`
          UPDATE agent_executions
          SET
            state = 'succeeded',
            output_json = ${output.json},
            updated_at = ${timestamp}
          WHERE session_reference_id = ${input.sessionReferenceId}
          AND state = 'session_ready'
        `
        return "completed" as const
      }).pipe(sql.withTransaction),
    recordFixResult,
    recordAgentFixResult: (input) =>
      Effect.gen(function* () {
        const timestamp = input.recordedAt.toISOString()
        const executions = yield* sql<{ readonly session_reference_id: string }>`
          SELECT execution.session_reference_id
          FROM agent_executions AS execution
          JOIN jobs AS candidate ON candidate.id = execution.job_id
          WHERE execution.session_reference_id = ${input.sessionReferenceId}
          AND execution.job_id = ${input.jobId}
          AND execution.state = 'session_ready'
          AND execution.attempt = candidate.attempts
          AND candidate.kind = 'fix'
          AND candidate.state = 'leased'
          AND candidate.cancel_requested = FALSE
          AND candidate.lease_owner = ${input.workerId}
          AND candidate.lease_until > ${timestamp}
          AND ${currentness.currentJob}
          AND ${currentness.latestReviewRequest}
        `
        if (executions.length === 0) return "stale" as const
        const output = yield* encodeDurablePayload(FixResult, AgentOutputEnvelope, input.result)
        const recorded = yield* recordFixResult({ ...input, result: output.decoded })
        if (recorded === "stale") return recorded
        yield* sql`
          UPDATE agent_executions
          SET
            state = 'succeeded',
            output_json = ${output.json},
            updated_at = ${timestamp}
          WHERE session_reference_id = ${input.sessionReferenceId}
          AND state = 'session_ready'
        `
        return "recorded" as const
      }).pipe(sql.withTransaction),
    recordAgentLaunchIntent: (input) =>
      Effect.gen(function* () {
        const timestamp = input.recordedAt.toISOString()
        const launchIntent = yield* encodeDurablePayload(
          AgentLaunchIntentSchema,
          AgentLaunchIntentEnvelope,
          input.intent,
        )
        const rows = yield* sql<{ readonly session_reference_id: string }>`
          INSERT INTO agent_executions (
            session_reference_id,
            job_id,
            attempt,
            lease_token,
            launch_intent_json,
            state,
            created_at,
            updated_at
          )
          SELECT
            ${input.intent.sessionReferenceId},
            candidate.id,
            candidate.attempts,
            ${input.intent.leaseToken},
            ${launchIntent.json},
            'launch_intent',
            ${timestamp},
            ${timestamp}
          FROM jobs AS candidate
          WHERE candidate.id = ${input.jobId}
          AND candidate.state = 'leased'
          AND candidate.cancel_requested = FALSE
          AND candidate.lease_owner = ${input.workerId}
          AND candidate.lease_until > ${timestamp}
          AND candidate.attempts = ${input.intent.attempt}
          AND ${currentness.currentJob}
          AND ${currentness.latestReviewRequest}
          ON CONFLICT DO NOTHING
          RETURNING session_reference_id
        `
        return rows.length === 0 ? ("stale" as const) : ("recorded" as const)
      }),
    recordAgentSessionReference: (input) => {
      const timestamp = input.recordedAt.toISOString()
      const referenceJson = JSON.stringify(input.reference)
      return Effect.gen(function* () {
        const current = yield* sql<{ readonly session_reference_id: string }>`
          UPDATE agent_executions
          SET
            session_reference_json = ${referenceJson},
            state = 'session_ready',
            updated_at = ${timestamp}
          WHERE session_reference_id = ${input.reference.sessionReferenceId}
          AND job_id = ${input.jobId}
          AND attempt = ${input.reference.attempt}
          AND lease_token = ${input.reference.leaseToken}
          AND state = 'launch_intent'
          AND EXISTS (
            SELECT 1
            FROM jobs AS candidate
            WHERE candidate.id = agent_executions.job_id
            AND candidate.state = 'leased'
            AND candidate.cancel_requested = FALSE
            AND candidate.lease_owner = ${input.workerId}
            AND candidate.lease_until > ${timestamp}
            AND candidate.attempts = agent_executions.attempt
            AND ${currentness.currentJob}
            AND ${currentness.latestReviewRequest}
          )
          RETURNING session_reference_id
        `
        if (current.length !== 0) return "recorded" as const

        yield* sql`
          UPDATE agent_executions
          SET
            session_reference_json = ${referenceJson},
            state = 'session_ready',
            updated_at = ${timestamp}
          WHERE session_reference_id = ${input.reference.sessionReferenceId}
          AND job_id = ${input.jobId}
          AND attempt = ${input.reference.attempt}
          AND lease_token = ${input.reference.leaseToken}
          AND state IN ('launch_intent', 'superseded')
        `
        return "stale" as const
      }).pipe(sql.withTransaction)
    },
    recordAgentSessionCleanupFailure: (input) =>
      Effect.gen(function* () {
        const timestamp = input.failedAt.toISOString()
        const executions = yield* sql<{
          readonly cleanup_disposition: "operator_required" | null
        }>`
          UPDATE agent_executions AS execution
          SET
            cleanup_disposition = CASE
              WHEN cleanup_attempts >= (
                SELECT candidate.max_attempts FROM jobs AS candidate
                WHERE candidate.id = execution.job_id
              ) THEN 'operator_required'
              ELSE cleanup_disposition
            END,
            cleanup_last_error = ${input.error},
            cleanup_lease_owner = CASE
              WHEN cleanup_attempts >= (
                SELECT candidate.max_attempts FROM jobs AS candidate
                WHERE candidate.id = execution.job_id
              ) THEN NULL ELSE cleanup_lease_owner END,
            cleanup_lease_until = CASE
              WHEN cleanup_attempts >= (
                SELECT candidate.max_attempts FROM jobs AS candidate
                WHERE candidate.id = execution.job_id
              ) THEN NULL ELSE cleanup_lease_until END,
            updated_at = ${timestamp}
          WHERE execution.session_reference_id = ${input.sessionReferenceId}
          AND execution.state = 'session_ready'
          AND execution.cleanup_lease_owner = ${input.workerId}
          AND execution.cleanup_lease_until > ${timestamp}
          RETURNING cleanup_disposition
        `
        const execution = executions[0]
        if (execution === undefined) return "stale" as const
        return execution.cleanup_disposition === "operator_required"
          ? ("operator_required" as const)
          : ("pending" as const)
      }).pipe(sql.withTransaction),
    rescheduleJob: (input) =>
      Effect.gen(function* () {
        const disposition = yield* queue.reschedule({ ...input, id: input.jobId })
        if (disposition === "stale" || input.execution === undefined) return disposition
        yield* sql`
          UPDATE agent_executions
          SET
            state = ${disposition === "retry" ? "superseded" : "failed"},
            updated_at = ${input.failedAt.toISOString()}
          WHERE job_id = ${input.jobId}
          AND attempt = ${input.execution.attempt}
          AND lease_token = ${input.execution.leaseToken}
          AND attempt = (SELECT attempts FROM jobs WHERE id = ${input.jobId})
          AND state IN ('launch_intent', 'session_ready')
        `
        return disposition
      }).pipe(sql.withTransaction),
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
    supersedeAgentSession: (sessionReferenceId, supersededAt) =>
      sql<{ readonly session_reference_id: string }>`
        UPDATE agent_executions
        SET state = 'superseded', updated_at = ${supersededAt.toISOString()}
        WHERE session_reference_id = ${sessionReferenceId}
        AND state = 'session_ready'
        RETURNING session_reference_id
      `.pipe(Effect.map((rows) => (rows.length === 0 ? "stale" : "superseded"))),
  } satisfies JobOperations
}

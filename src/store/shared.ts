import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect } from "effect"
import type { ReviewResult } from "../domain/review-result"
import { decideFixCandidate } from "../domain/transaction-policy"
import type { DeliveryInput } from "./model"
import { makeCurrentnessPolicy } from "./currentness"

export function makeSharedStoreOperations(sql: SqlClient) {
  const currentness = makeCurrentnessPolicy(sql)
  const insertDelivery = (delivery: DeliveryInput) =>
    sql<{ readonly delivery_id: string; readonly observation_sequence: number }>`
      INSERT OR IGNORE INTO webhook_deliveries (
        delivery_id,
        event,
        action,
        payload,
        received_at,
        observation_sequence
      ) VALUES (
        ${delivery.deliveryId},
        ${delivery.event},
        ${delivery.action},
        ${delivery.payload},
        ${delivery.receivedAt.toISOString()},
        (SELECT COALESCE(MAX(observation_sequence), 0) + 1 FROM webhook_deliveries)
      )
      RETURNING delivery_id, observation_sequence
    `

  const supersedeOlderReviewWork = (input: {
    readonly pullRequestNumber: number
    readonly repositoryId: number
    readonly reviewJobId: number
    readonly timestamp: string
  }) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE agent_executions
        SET state = 'superseded', updated_at = ${input.timestamp}
        WHERE state = 'launch_intent'
        AND job_id IN (
          SELECT id FROM jobs
          WHERE kind = 'fix'
          AND repository_id = ${input.repositoryId}
          AND pull_request_number = ${input.pullRequestNumber}
          AND generation = (
            SELECT generation FROM jobs WHERE id = ${input.reviewJobId}
          )
          AND review_request_number < (
            SELECT review_request_number FROM jobs WHERE id = ${input.reviewJobId}
          )
        )
      `
      yield* sql`
        UPDATE publications
        SET
          state = 'superseded',
          lease_owner = NULL,
          lease_until = NULL,
          last_error = 'newer review requested',
          updated_at = ${input.timestamp}
        WHERE repository_id = ${input.repositoryId}
        AND pull_request_number = ${input.pullRequestNumber}
        AND generation = (
          SELECT generation FROM jobs WHERE id = ${input.reviewJobId}
        )
        AND review_request_number < (
          SELECT review_request_number FROM jobs WHERE id = ${input.reviewJobId}
        )
        AND state IN ('ready', 'leased', 'retry_scheduled', 'succeeded')
      `
      yield* sql`
        UPDATE jobs
        SET
          state = 'superseded',
          cancel_requested = TRUE,
          lease_owner = NULL,
          lease_until = NULL,
          last_error = NULL,
          updated_at = ${input.timestamp}
        WHERE kind = 'fix'
        AND repository_id = ${input.repositoryId}
        AND pull_request_number = ${input.pullRequestNumber}
        AND generation = (
          SELECT generation FROM jobs WHERE id = ${input.reviewJobId}
        )
        AND review_request_number < (
          SELECT review_request_number FROM jobs WHERE id = ${input.reviewJobId}
        )
        AND state IN ('ready', 'leased', 'retry_scheduled')
      `
    })

  const supersedePullRequestWork = (input: {
    readonly generation: number
    readonly includeCurrentGeneration: boolean
    readonly publicationReason: string
    readonly pullRequestNumber: number
    readonly repositoryId: number
    readonly timestamp: string
  }) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE agent_executions
        SET state = 'superseded', updated_at = ${input.timestamp}
        WHERE state = 'launch_intent'
        AND job_id IN (
          SELECT id FROM jobs
          WHERE repository_id = ${input.repositoryId}
          AND pull_request_number = ${input.pullRequestNumber}
          AND (
            generation < ${input.generation}
            OR (${input.includeCurrentGeneration} AND generation = ${input.generation})
          )
        )
      `
      yield* sql`
        UPDATE jobs
        SET
          state = 'superseded',
          cancel_requested = TRUE,
          lease_owner = NULL,
          lease_until = NULL,
          last_error = NULL,
          updated_at = ${input.timestamp}
        WHERE repository_id = ${input.repositoryId}
        AND pull_request_number = ${input.pullRequestNumber}
        AND (
          generation < ${input.generation}
          OR (
            ${input.includeCurrentGeneration}
            AND generation = ${input.generation}
          )
        )
        AND state IN ('ready', 'retry_scheduled', 'leased')
      `
      yield* sql`
        UPDATE publications
        SET
          state = 'superseded',
          lease_owner = NULL,
          lease_until = NULL,
          last_error = ${input.publicationReason},
          updated_at = ${input.timestamp}
        WHERE repository_id = ${input.repositoryId}
        AND pull_request_number = ${input.pullRequestNumber}
        AND (
          generation < ${input.generation}
          OR (
            ${input.includeCurrentGeneration}
            AND generation = ${input.generation}
          )
        )
        AND state IN ('ready', 'retry_scheduled', 'leased')
      `
    })

  const enqueueFixFromReview = (input: {
    readonly headRepositoryFullName: string
    readonly requestedAt: string
    readonly repositoryFullName: string
    readonly review: ReviewResult
    readonly reviewJobId: number
    readonly requeueFailed: boolean
  }) => {
    const eligible = decideFixCandidate(input)._tag === "Eligible"
    return sql<{ readonly id: number }>`
      INSERT INTO jobs (
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
        state,
        run_at,
        created_at,
        updated_at
      )
      SELECT
        'fix',
        review.installation_id,
        review.repository_id,
        review.repository_full_name,
        review.pull_request_number,
        review.author,
        review.base_ref,
        review.base_sha,
        review.expected_head_sha,
        review.head_ref,
        review.head_repository_full_name,
        review.generation,
        review.review_request_number,
        candidate.id,
        candidate.review_json,
        'ready',
        ${input.requestedAt},
        ${input.requestedAt},
        ${input.requestedAt}
      FROM publications AS candidate
      JOIN jobs AS review
        ON review.repository_id = candidate.repository_id
        AND review.pull_request_number = candidate.pull_request_number
        AND review.generation = candidate.generation
        AND review.review_request_number = candidate.review_request_number
      WHERE review.id = ${input.reviewJobId}
      AND ${eligible}
      AND review.kind = 'review'
      AND review.state = 'succeeded'
      AND candidate.state IN ('ready', 'leased', 'retry_scheduled', 'succeeded')
      AND ${currentness.currentPublication}
      AND ${currentness.latestReviewRequest}
      ON CONFLICT (
        kind,
        repository_id,
        pull_request_number,
        generation,
        review_request_number
      ) DO UPDATE SET
        publication_id = excluded.publication_id,
        review_json = excluded.review_json,
        state = 'ready',
        attempts = 0,
        max_attempts = 3,
        run_at = excluded.run_at,
        lease_owner = NULL,
        lease_until = NULL,
        cancel_requested = FALSE,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE ${input.requeueFailed}
      AND jobs.state = 'failed'
       RETURNING id
     `
  }

  return {
    enqueueFixFromReview,
    insertDelivery,
    supersedeOlderReviewWork,
    supersedePullRequestWork,
  }
}

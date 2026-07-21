import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect } from "effect"
import type { Publication } from "../domain/publication"
import { decodePublicationRow } from "./codecs"
import type { WorkflowStorePort } from "./contracts"
import { makeCurrentnessPolicy } from "./currentness"
import { SqlLeaseQueue } from "./lease"

type PublicationOperations = Pick<
  WorkflowStorePort,
  "claimNextPublication" | "completePublication" | "isPublicationCurrent" | "reschedulePublication"
>

export function makePublicationOperations(sql: SqlClient): PublicationOperations {
  const currentness = makeCurrentnessPolicy(sql)
  const queue = new SqlLeaseQueue<Publication>(sql, {
    table: "publications",
    claimableId: currentness.publicationClaimCandidate,
    returning: sql.literal(`
        id,
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
        attempts
    `),
    decode: decodePublicationRow,
  })

  return {
    claimNextPublication: (input) => queue.claim(input),
    isPublicationCurrent: (publicationId, workerId, now) =>
      sql<{ readonly current: number }>`
        SELECT 1 AS current
        FROM publications AS candidate
        WHERE candidate.id = ${publicationId}
        AND candidate.state = 'leased'
        AND candidate.lease_owner = ${workerId}
        AND candidate.lease_until > ${now.toISOString()}
        AND ${currentness.currentPublication}
        AND ${currentness.latestReviewRequest}
      `.pipe(Effect.map((rows) => rows.length > 0)),

    completePublication: (input) =>
      Effect.gen(function* () {
        const published =
          input.outcome === "published"
            ? yield* sql<{ readonly id: number }>`
            UPDATE publications AS candidate
            SET state = 'succeeded', lease_owner = NULL, lease_until = NULL,
              last_error = NULL, updated_at = ${input.completedAt.toISOString()}
            WHERE candidate.id = ${input.publicationId}
            AND candidate.state = 'leased'
            AND candidate.lease_owner = ${input.workerId}
            AND candidate.lease_until > ${input.completedAt.toISOString()}
            AND ${currentness.currentPublication}
            AND ${currentness.latestReviewRequest}
            RETURNING id
          `
            : []
        if (published.length > 0) return "completed" as const
        yield* sql`
          UPDATE publications
          SET state = 'superseded', lease_owner = NULL, lease_until = NULL,
            last_error = 'publication superseded', updated_at = ${input.completedAt.toISOString()}
          WHERE id = ${input.publicationId}
          AND state = 'leased'
          AND lease_owner = ${input.workerId}
          AND lease_until > ${input.completedAt.toISOString()}
        `
        return "stale" as const
      }).pipe(sql.withTransaction),
    reschedulePublication: (input) => queue.reschedule({ ...input, id: input.publicationId }),
  }
}

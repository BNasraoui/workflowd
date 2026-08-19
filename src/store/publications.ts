import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect } from "effect"
import type { Publication } from "../domain/publication"
import { decodePublicationRow } from "./codecs"
import type { WorkflowStorePort } from "./contracts"
import { makeCurrentnessPolicy } from "./currentness"
import { SqlLeaseQueue } from "./lease"
import { makeWorkStatePolicy } from "./work-state"

type PublicationOperations = Pick<
  WorkflowStorePort,
  "claimNextPublication" | "completePublication" | "isPublicationCurrent" | "reschedulePublication"
>

export function makePublicationOperations(sql: SqlClient): PublicationOperations {
  const currentness = makeCurrentnessPolicy(sql)
  const workState = makeWorkStatePolicy(sql)
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
        (
          SELECT execution.session_reference_json
          FROM agent_executions AS execution
          WHERE execution.session_reference_id = publications.session_reference_id
        ) AS session_reference_json,
        (
          SELECT execution.state
          FROM agent_executions AS execution
          WHERE execution.session_reference_id = publications.session_reference_id
        ) AS session_execution_state,
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
        AND ${workState.leaseHeldBy(workerId, now.toISOString(), "candidate")}
        AND ${currentness.currentPublication}
        AND ${currentness.latestReviewRequest}
      `.pipe(Effect.map((rows) => rows.length > 0)),

    completePublication: (input) =>
      Effect.gen(function* () {
        const published =
          input.outcome === "published"
            ? yield* sql<{ readonly id: number }>`
            UPDATE publications AS candidate
            SET state = 'succeeded', ${workState.releaseLease},
              last_error = NULL, updated_at = ${input.completedAt.toISOString()}
            WHERE candidate.id = ${input.publicationId}
            AND ${workState.leaseHeldBy(input.workerId, input.completedAt.toISOString(), "candidate")}
            AND ${currentness.currentPublication}
            AND ${currentness.latestReviewRequest}
            RETURNING id
          `
            : []
        if (published.length > 0) return "completed" as const
        yield* sql`
          UPDATE publications
          SET state = 'superseded', ${workState.releaseLease},
            last_error = 'publication superseded', updated_at = ${input.completedAt.toISOString()}
          WHERE id = ${input.publicationId}
          AND ${workState.leaseHeldBy(input.workerId, input.completedAt.toISOString())}
        `
        return "stale" as const
      }).pipe(sql.withTransaction),
    reschedulePublication: (input) => queue.reschedule({ ...input, id: input.publicationId }),
  }
}

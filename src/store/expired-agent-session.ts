import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { Effect } from "effect"
import type { WorkflowStorePort } from "./contracts"
import { decodeAgentSessionReferenceRow } from "./codecs"

export const claimExpiredAgentSession =
  (sql: SqlClient): WorkflowStorePort["claimExpiredAgentSession"] =>
  (input) =>
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
        const decoded = yield* Effect.result(decodeAgentSessionReferenceRow(row))
        const mismatch =
          decoded._tag === "Success" &&
          decoded.success.sessionReference.sessionReferenceId !== row.session_reference_id
        if (decoded._tag === "Success" && !mismatch) return decoded.success.sessionReference

        const message =
          decoded._tag === "Failure"
            ? decoded.failure.message
            : `Stored SessionReference identity ${decoded.success.sessionReference.sessionReferenceId} does not match ${row.session_reference_id}`
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
    }).pipe(sql.withTransaction)

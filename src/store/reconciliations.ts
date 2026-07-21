import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect } from "effect"
import { decodeReconciliationRow } from "./codecs"
import type { WorkflowStorePort } from "./contracts"
import { reconciliationClaimCandidate } from "./internal-claim-queries"
import { SqlLeaseQueue } from "./lease"
import type { PullRequestReconciliation } from "./model"
import type { makePullRequestTransition } from "./pull-requests"

type ReconciliationOperations = Pick<
  WorkflowStorePort,
  "applyReconciliationSnapshot" | "claimNextReconciliation" | "rescheduleReconciliation"
>

export function makeReconciliationOperations(
  sql: SqlClient,
  applyTransition: ReturnType<typeof makePullRequestTransition>,
): ReconciliationOperations {
  const queue = new SqlLeaseQueue<PullRequestReconciliation>(sql, {
    table: "reconciliations",
    claimableId: (now) => reconciliationClaimCandidate(sql, now),
    returning: sql.literal(`
        id,
        installation_id,
        repository_id,
        repository_full_name,
        pull_request_number,
        attempts
    `),
    decode: decodeReconciliationRow,
  })
  return {
    applyReconciliationSnapshot: (input) =>
      Effect.gen(function* () {
        const claimed = yield* sql<{ readonly id: number }>`
          SELECT id
          FROM reconciliations
          WHERE id = ${input.reconciliationId}
          AND installation_id = ${input.snapshot.installationId}
          AND repository_id = ${input.snapshot.repository.id}
          AND pull_request_number = ${input.snapshot.pullRequest.number}
          AND state = 'leased'
          AND lease_owner = ${input.workerId}
          AND lease_until > ${input.completedAt.toISOString()}
        `
        if (claimed.length === 0) return "stale" as const

        const result = yield* applyTransition({
          appliedAt: input.completedAt,
          snapshot: input.snapshot,
        })
        if (result.status === "reconciliation_enqueued") {
          return yield* Effect.dieMessage("authoritative snapshot requested reconciliation")
        }
        const completed = yield* sql<{ readonly id: number }>`
          UPDATE reconciliations
          SET
            state = 'succeeded',
            lease_owner = NULL,
            lease_until = NULL,
            last_error = NULL,
            updated_at = ${input.completedAt.toISOString()}
          WHERE id = ${input.reconciliationId}
          AND state = 'leased'
          AND lease_owner = ${input.workerId}
          AND lease_until > ${input.completedAt.toISOString()}
          RETURNING id
        `
        return completed.length === 0 ? ("stale" as const) : ("completed" as const)
      }).pipe(sql.withTransaction),
    claimNextReconciliation: (input) => queue.claim(input),
    rescheduleReconciliation: (input) => queue.reschedule({ ...input, id: input.reconciliationId }),
  }
}

import type { SqlClient } from "@effect/sql/SqlClient"
import { makeWorkStatePolicy } from "./work-state"

export function commandClaimCandidate(sql: SqlClient, now: string) {
  const workState = makeWorkStatePolicy(sql)
  return sql`
    SELECT id
    FROM commands
    WHERE ${workState.claimable(now)}
    AND attempts < max_attempts
    AND run_at <= ${now}
    ORDER BY run_at ASC, id ASC
    LIMIT 1
  `
}

export function reconciliationClaimCandidate(sql: SqlClient, now: string) {
  const workState = makeWorkStatePolicy(sql)
  return sql`
    SELECT id
    FROM reconciliations
    WHERE ${workState.claimable(now)}
    AND run_at <= ${now}
    AND attempts < max_attempts
    ORDER BY run_at ASC, id ASC
    LIMIT 1
  `
}

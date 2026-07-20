import type { SqlClient } from "@effect/sql/SqlClient"

export function commandClaimCandidate(sql: SqlClient, now: string) {
  return sql`
    SELECT id
    FROM commands
    WHERE (
      state IN ('ready', 'retry_scheduled')
      OR (state = 'leased' AND lease_until <= ${now})
    )
    AND attempts < max_attempts
    AND run_at <= ${now}
    ORDER BY run_at ASC, id ASC
    LIMIT 1
  `
}

export function reconciliationClaimCandidate(sql: SqlClient, now: string) {
  return sql`
    SELECT id
    FROM reconciliations
    WHERE (
      state IN ('ready', 'retry_scheduled')
      OR (state = 'leased' AND lease_until <= ${now})
    )
    AND run_at <= ${now}
    AND attempts < max_attempts
    ORDER BY run_at ASC, id ASC
    LIMIT 1
  `
}

import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

// A SQL client owns one local notification domain. Durable state remains the
// authority; this only synchronizes in-process effects with store transitions.
const domains = new WeakMap<SqlClient, ReturnType<typeof make>>()
function make(sql: SqlClient) {
  const listeners = new Map<string, Set<() => void>>()
  const invalidate = (runId: string) => {
    for (const stop of listeners.get(runId) ?? []) stop()
  }
  return {
    // SQLite's existing transaction connection is the admission fence. Nested
    // callers reuse it through savepoints; there is no second lock to invert.
    withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect),
    listen(runId: string, stop: () => void) {
      const owned = listeners.get(runId) ?? new Set<() => void>()
      owned.add(stop)
      listeners.set(runId, owned)
      return () => {
        owned.delete(stop)
        if (!owned.size) listeners.delete(runId)
      }
    },
    change: <A, E, R>(
      runId: string,
      effect: Effect.Effect<A, E, R>,
      transaction: SqlClient["withTransaction"] = sql.withTransaction,
    ) =>
      transaction(
        // Abort is deliberately conservative on rollback: an interrupted stream
        // cannot be resumed, but no durable revocation or sticky local flag is
        // published. The next request always reads the committed SQL authority.
        Effect.sync(() => invalidate(runId)).pipe(Effect.andThen(effect), Effect.uninterruptible),
      ),
  }
}
export function runLifetime(sql: SqlClient) {
  let domain = domains.get(sql)
  if (!domain) {
    domain = make(sql)
    domains.set(sql, domain)
  }
  return domain
}

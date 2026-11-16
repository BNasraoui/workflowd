import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/**
 * The gateway keeps its own store, so workflowd's holds none of its tables. The two triggers that
 * revoked a binding when a run or its lease changed go: workflowd now sends that revoke on the
 * gateway's control socket. The rows of the bindings, run tokens and used proofs are dropped. Each
 * was a lease of minutes for a runner session; workflowd grants each live run again on the socket,
 * and its runner opens a new session.
 */
export const capabilityStoreSplit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TRIGGER IF EXISTS capability_run_revoke`
  yield* sql`DROP TRIGGER IF EXISTS capability_lease_revoke`
  yield* sql`DROP TABLE IF EXISTS capability_proofs`
  yield* sql`DROP TABLE IF EXISTS capability_tokens`
  yield* sql`DROP TABLE IF EXISTS capability_bindings`
})

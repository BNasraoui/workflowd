import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/**
 * A binding keeps its live challenge nonce, so a repeated challenge request gets the same one
 * back. A used proof keeps the expiry of its proof, so its row can go once the proof is refused
 * anyway; a row that the migration finds gets 610 seconds from the migration, the longest life
 * of a proof and its leeway.
 */
export const capabilityRenewal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE capability_bindings ADD COLUMN nonce TEXT CHECK(nonce IS NULL OR length(nonce)=64)`
  yield* sql`ALTER TABLE capability_proofs ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0`
  yield* sql`UPDATE capability_proofs SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+610000`
})

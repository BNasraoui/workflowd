import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/**
 * A binding counts the sessions its runner opened; each run token belongs to one session, and
 * each proof (by jti) opens at most one.
 */
export const capabilitySession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE capability_bindings ADD COLUMN session INTEGER NOT NULL DEFAULT 0 CHECK(session>=0)`
  yield* sql`ALTER TABLE capability_tokens ADD COLUMN session INTEGER NOT NULL DEFAULT 0 CHECK(session>=0)`
  yield* sql`CREATE TABLE capability_proofs (
    jti_digest TEXT PRIMARY KEY CHECK(length(jti_digest)=64),
    run_id TEXT NOT NULL REFERENCES capability_bindings(run_id)
  ) STRICT`
})

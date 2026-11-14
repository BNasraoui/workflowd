import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export const nativeResults = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE sandbox_native_executions (
    run_id TEXT PRIMARY KEY REFERENCES capability_bindings(run_id),
    channel TEXT NOT NULL REFERENCES capability_bindings(channel),
    nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=64),
    container_nonce TEXT NOT NULL UNIQUE CHECK(length(container_nonce)=64),
    predecessor TEXT,
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 100),
    session_id TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    response_sequence INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    finalize_revision INTEGER CHECK(finalize_revision BETWEEN 1 AND 100),
    finalize_claimed INTEGER NOT NULL DEFAULT 0 CHECK(finalize_claimed IN (0,1)),
    deadline INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('launching','running','paused','uncertain','stopped')),
    outcome TEXT CHECK(outcome IN ('completed','paused','cancelled','operator_required'))
  ) STRICT`
  yield* sql`CREATE TABLE sandbox_native_results (
    run_id TEXT PRIMARY KEY REFERENCES capability_bindings(run_id),
    channel TEXT NOT NULL REFERENCES capability_bindings(channel),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 100),
    completion TEXT NOT NULL CHECK(json_valid(completion) AND length(completion)<=65536),
    frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0,1))
  ) STRICT`
})

import { Effect } from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"
import { gatewayMigrationsTable } from "../capability-control/protocol"

/**
 * The gateway's own store. A grant is what workflowd authorized for one run, sent on the control
 * socket; the gateway reads no table of workflowd. A binding, its run tokens and its used proofs
 * belong to one grant.
 */
const capabilityStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE capability_grants (
    run_id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL UNIQUE,
    grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
  ) STRICT`
  yield* sql`CREATE TABLE capability_bindings (
    run_id TEXT PRIMARY KEY REFERENCES capability_grants(run_id),
    channel TEXT NOT NULL UNIQUE CHECK(length(channel)=64),
    challenge TEXT NOT NULL UNIQUE CHECK(length(challenge)=64),
    challenge_expires INTEGER NOT NULL,
    authority TEXT NOT NULL CHECK(json_valid(authority)),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
    session INTEGER NOT NULL DEFAULT 0 CHECK(session>=0),
    nonce TEXT CHECK(nonce IS NULL OR length(nonce)=64)
  ) STRICT`
  yield* sql`CREATE TABLE capability_tokens (
    digest TEXT PRIMARY KEY CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
    run_id TEXT NOT NULL REFERENCES capability_bindings(run_id),
    predecessor TEXT UNIQUE REFERENCES capability_tokens(digest),
    expires_at INTEGER NOT NULL,
    session INTEGER NOT NULL DEFAULT 0 CHECK(session>=0),
    replaced INTEGER NOT NULL DEFAULT 0
  ) STRICT`
  yield* sql`CREATE INDEX capability_tokens_run ON capability_tokens(run_id)`
  yield* sql`CREATE TABLE capability_proofs (
    jti_digest TEXT PRIMARY KEY CHECK(length(jti_digest)=64),
    run_id TEXT NOT NULL REFERENCES capability_bindings(run_id),
    expires_at INTEGER NOT NULL
  ) STRICT`
})

/**
 * What each run spent of its budget: the calls sent to the provider, the token counts that the
 * provider reported, and whether the budget refused a call. A reservation is the `max_tokens` of a
 * call that has started and not yet been settled; its id is random, so it is never used twice.
 */
const runUsage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE capability_usage (
    run_id TEXT PRIMARY KEY REFERENCES capability_grants(run_id),
    calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_creation_input_tokens>=0),
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_input_tokens>=0),
    spent INTEGER NOT NULL DEFAULT 0 CHECK(spent IN (0,1))
  ) STRICT`
  yield* sql`CREATE TABLE capability_reservations (
    id TEXT PRIMARY KEY CHECK(length(id)=32 AND id NOT GLOB '*[^a-f0-9]*'),
    run_id TEXT NOT NULL REFERENCES capability_usage(run_id),
    tokens INTEGER NOT NULL CHECK(tokens>=0)
  ) STRICT`
  yield* sql`CREATE INDEX capability_reservations_run ON capability_reservations(run_id)`
})

/**
 * The session key of a binding, which signs each renewal of its run tokens, and the highest
 * attempt number of a renewal that the gateway took for the session (0 before the first; its
 * bound is `maxRenewalAttempt`). A binding with no session key renews no run token. When a run
 * token first authorized a call; and why the gateway ended a run, when it ended the run itself:
 * only "two holders", and only on a revoked run.
 */
const sessionKey = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE capability_bindings ADD COLUMN session_key TEXT
    CHECK(session_key IS NULL OR length(session_key)=43)`
  yield* sql`ALTER TABLE capability_bindings ADD COLUMN renewal_attempt INTEGER NOT NULL DEFAULT 0
    CHECK(renewal_attempt BETWEEN 0 AND 999999999)`
  yield* sql`ALTER TABLE capability_tokens ADD COLUMN used_at INTEGER
    CHECK(used_at IS NULL OR used_at>0)`
  yield* sql`ALTER TABLE capability_grants ADD COLUMN end_reason TEXT
    CHECK(end_reason IS NULL OR (end_reason='two holders' AND revoked=1))`
})

/**
 * What a runner run posts on its run routes: its event batches, numbered 1, 2, 3, … with no gap,
 * and its one result, the exact bytes that it posted. Neither is ever replaced.
 */
const runRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE capability_run_events (
    run_id TEXT NOT NULL REFERENCES capability_grants(run_id),
    sequence INTEGER NOT NULL CHECK(sequence>=1),
    lines TEXT NOT NULL CHECK(json_valid(lines)),
    bytes INTEGER NOT NULL CHECK(bytes>=0),
    PRIMARY KEY(run_id,sequence)
  ) STRICT`
  yield* sql`CREATE TABLE capability_run_results (
    run_id TEXT PRIMARY KEY REFERENCES capability_grants(run_id),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    body BLOB NOT NULL
  ) STRICT`
})

/**
 * The head of each runner run's event batches: the last sequence and the bytes of all of them, in
 * one row, so a batch is held with no read of the batches before it.
 */
const runEventHeads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE capability_run_event_heads (
    run_id TEXT PRIMARY KEY REFERENCES capability_grants(run_id),
    last INTEGER NOT NULL CHECK(last>=1),
    total INTEGER NOT NULL CHECK(total>=0)
  ) STRICT`
  yield* sql`INSERT INTO capability_run_event_heads(run_id,last,total)
    SELECT run_id,max(sequence),sum(bytes) FROM capability_run_events GROUP BY run_id`
})

/** The migrations of the gateway's store, by name, in their order. */
export const gatewayMigrations = {
  "0001_capability_store": capabilityStore,
  "0002_run_usage": runUsage,
  "0003_session_key": sessionKey,
  "0004_run_records": runRecords,
  "0005_run_event_heads": runEventHeads,
}

export const runGatewayMigrations = Migrator.make({})({
  loader: Migrator.fromRecord(gatewayMigrations),
  table: gatewayMigrationsTable,
})

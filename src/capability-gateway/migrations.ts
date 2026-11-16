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

export const runGatewayMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_capability_store": capabilityStore,
    "0002_run_usage": runUsage,
  }),
  table: gatewayMigrationsTable,
})

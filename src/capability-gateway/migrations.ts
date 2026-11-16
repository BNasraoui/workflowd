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
 * The session key of a binding, which signs each renewal of its run tokens; when a run token
 * first authorized a call; and why the gateway ended a run, when it ended the run itself.
 */
const sessionKey = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE capability_bindings ADD COLUMN session_key TEXT
    CHECK(session_key IS NULL OR length(session_key)=43)`
  yield* sql`ALTER TABLE capability_tokens ADD COLUMN used_at INTEGER`
  yield* sql`ALTER TABLE capability_grants ADD COLUMN end_reason TEXT`
})

export const runGatewayMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_capability_store": capabilityStore,
    "0002_session_key": sessionKey,
  }),
  table: gatewayMigrationsTable,
})

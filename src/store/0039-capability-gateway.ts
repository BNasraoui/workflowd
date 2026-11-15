import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export const capabilityGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE capability_bindings (
    run_id TEXT PRIMARY KEY REFERENCES kernel_agent_runs(run_id),
    channel TEXT NOT NULL UNIQUE CHECK(length(channel)=64),
    challenge TEXT NOT NULL UNIQUE CHECK(length(challenge)=64),
    challenge_expires INTEGER NOT NULL,
    authority TEXT NOT NULL CHECK(json_valid(authority)),
    transport_digest TEXT NOT NULL CHECK(length(transport_digest)=64),
    jti_digest TEXT UNIQUE CHECK(jti_digest IS NULL OR length(jti_digest)=64),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
  ) STRICT`
  yield* sql`CREATE TABLE capability_tokens (
    digest TEXT PRIMARY KEY CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
    run_id TEXT NOT NULL REFERENCES capability_bindings(run_id),
    predecessor TEXT UNIQUE REFERENCES capability_tokens(digest),
    expires_at INTEGER NOT NULL
  ) STRICT`
  yield* sql`CREATE INDEX capability_tokens_run ON capability_tokens(run_id)`
  yield* sql`CREATE TRIGGER capability_run_revoke AFTER UPDATE OF state,attempt ON kernel_agent_runs
    WHEN NEW.state NOT IN ('spawning','spawned','verified') OR NEW.attempt != OLD.attempt
    BEGIN UPDATE capability_bindings SET revoked=1 WHERE run_id=NEW.run_id; END`
  yield* sql`CREATE TRIGGER capability_lease_revoke AFTER UPDATE OF state,actions_run_id,actions_attempt ON sandbox_leases
    WHEN NEW.state NOT IN ('starting','ready') OR NEW.actions_run_id IS NOT OLD.actions_run_id OR NEW.actions_attempt IS NOT OLD.actions_attempt
    BEGIN UPDATE capability_bindings SET revoked=1 WHERE run_id=NEW.run_id; END`
})

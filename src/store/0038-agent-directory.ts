import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export const agentDirectory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE directory_local_identity(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), host_id TEXT NOT NULL) STRICT`
  yield* sql`CREATE TABLE directory_managed(run_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL, binding_version INTEGER NOT NULL DEFAULT 1, verified_native_session_id TEXT, observed_directory TEXT, endpoint_observed_at TEXT, endpoint_expires_at TEXT) STRICT`
  yield* sql`CREATE TABLE directory_external(recipient_id TEXT PRIMARY KEY, host_id TEXT NOT NULL,
    revision INTEGER NOT NULL, registration_json TEXT NOT NULL, endpoint_address TEXT NOT NULL UNIQUE,
    observed_at TEXT NOT NULL, expires_at TEXT NOT NULL, unavailable INTEGER NOT NULL DEFAULT 0 CHECK(unavailable IN (0,1))) STRICT`
  yield* sql`CREATE TABLE directory_peer_observations(host_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0,
    request_json TEXT, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)), snapshot_json TEXT,
    observed_at TEXT, expires_at TEXT) STRICT`
  yield* sql`CREATE TABLE directory_observation_pages(host_id TEXT NOT NULL, generation INTEGER NOT NULL, page INTEGER NOT NULL,
    total INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(host_id,generation,page)) STRICT`
  yield* sql`CREATE TABLE directory_owner_bindings(recipient_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, revision INTEGER NOT NULL, registration_json TEXT NOT NULL) STRICT`
  yield* sql`CREATE TABLE directory_runner_responses(coordinator_host_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
    request_json TEXT NOT NULL, response_json TEXT NOT NULL) STRICT`
  yield* sql`CREATE TRIGGER directory_managed_accept AFTER INSERT ON kernel_agent_runs BEGIN
    INSERT INTO directory_managed(run_id, recipient_id, host_id)
    SELECT NEW.run_id, 'managed:' || host_id || ':' || NEW.run_id, host_id FROM directory_local_identity WHERE singleton = 1
    ON CONFLICT DO NOTHING;
  END`
  yield* sql`CREATE TRIGGER directory_managed_rebind AFTER UPDATE OF native_session_id,session_id ON kernel_agent_runs
    WHEN NEW.native_session_id IS NOT OLD.native_session_id OR NEW.session_id IS NOT OLD.session_id BEGIN
      UPDATE directory_managed SET binding_version = binding_version + 1, verified_native_session_id = NULL, observed_directory = NULL, endpoint_observed_at = NULL, endpoint_expires_at = NULL WHERE run_id = NEW.run_id;
    END`
  yield* sql`CREATE TRIGGER directory_resident_reacquire AFTER UPDATE OF closure_confirmed ON resident_threads
    WHEN NEW.provider_kind = 'codex' BEGIN
      UPDATE directory_managed SET verified_native_session_id = NULL WHERE run_id = NEW.run_id;
    END`
})

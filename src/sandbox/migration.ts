import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export const sandboxMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE sandbox_leases (
    run_id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL UNIQUE,
    policy TEXT NOT NULL CHECK(json_valid(policy)),
    source_sha TEXT NOT NULL CHECK(length(source_sha)=40),
    state TEXT NOT NULL CHECK(state IN ('requested','starting','ready','releasing','released','operator_required')),
    actions_run_id INTEGER, actions_attempt INTEGER,
    peer_id TEXT, transport TEXT CHECK(transport IS NULL OR json_valid(transport)),
    session_id TEXT, unit TEXT, invocation TEXT,
    created_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
    release_error TEXT,
    CHECK((actions_run_id IS NULL) = (actions_attempt IS NULL)),
    CHECK(state != 'ready' OR (actions_run_id IS NOT NULL AND peer_id IS NOT NULL AND transport IS NOT NULL))
  ) STRICT`
  yield* sql`CREATE UNIQUE INDEX sandbox_actions_run ON sandbox_leases(json_extract(policy,'$.repositoryId'),actions_run_id)`
  yield* sql`CREATE TRIGGER sandbox_immutable_intent BEFORE UPDATE ON sandbox_leases
    WHEN NEW.run_id != OLD.run_id OR NEW.lease_id != OLD.lease_id OR NEW.policy != OLD.policy
      OR NEW.source_sha != OLD.source_sha OR NEW.created_at != OLD.created_at OR NEW.deadline != OLD.deadline
    BEGIN SELECT RAISE(ABORT,'immutable sandbox intent'); END`
})

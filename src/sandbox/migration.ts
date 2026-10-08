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

export const sandboxCleanupMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE sandbox_cleanup_runs (
    repository_id INTEGER NOT NULL CHECK(repository_id > 0),
    actions_run_id INTEGER NOT NULL CHECK(actions_run_id > 0),
    actions_attempt INTEGER NOT NULL CHECK(actions_attempt = 1),
    lease_id TEXT NOT NULL CHECK(length(lease_id) BETWEEN 1 AND 80 AND lease_id NOT GLOB '*[^a-zA-Z0-9-]*'),
    policy TEXT NOT NULL CHECK(json_valid(policy) AND json_extract(policy,'$.repositoryId') IS NOT NULL AND json_extract(policy,'$.repositoryId') = repository_id),
    state TEXT NOT NULL CHECK(state IN ('pending','terminated','released')),
    observed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT,
    PRIMARY KEY(repository_id, actions_run_id, actions_attempt)
  ) STRICT`
  yield* sql`CREATE INDEX sandbox_cleanup_lease ON sandbox_cleanup_runs(repository_id,lease_id,state)`
  yield* sql`CREATE TRIGGER sandbox_cleanup_immutable BEFORE UPDATE ON sandbox_cleanup_runs
    WHEN NEW.repository_id != OLD.repository_id OR NEW.actions_run_id != OLD.actions_run_id
      OR NEW.actions_attempt != OLD.actions_attempt OR NEW.lease_id != OLD.lease_id
      OR NEW.policy != OLD.policy OR NEW.observed_at != OLD.observed_at
    BEGIN SELECT RAISE(ABORT,'immutable sandbox cleanup custody'); END`
  yield* sql`INSERT INTO sandbox_cleanup_runs
    (repository_id,actions_run_id,actions_attempt,lease_id,policy,state,observed_at,updated_at)
    SELECT json_extract(policy,'$.repositoryId'),actions_run_id,actions_attempt,lease_id,policy,'pending',created_at,heartbeat_at
    FROM sandbox_leases WHERE state != 'released' AND actions_run_id IS NOT NULL`
})

// Separate from lease rows so orphan Actions runs have the same durable fence.
export const sandboxOperationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE sandbox_lease_operations (
    repository_id INTEGER NOT NULL CHECK(repository_id > 0),
    lease_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    owner TEXT,
    expires_at INTEGER,
    PRIMARY KEY(repository_id,lease_id),
    CHECK((owner IS NULL) = (expires_at IS NULL))
  ) STRICT`
  yield* sql`INSERT INTO sandbox_lease_operations(repository_id,lease_id)
    SELECT json_extract(policy,'$.repositoryId'),lease_id FROM sandbox_leases
    UNION SELECT repository_id,lease_id FROM sandbox_cleanup_runs`
  yield* sql`CREATE TRIGGER sandbox_cleanup_adoption_fence AFTER INSERT ON sandbox_cleanup_runs
    BEGIN
      INSERT INTO sandbox_lease_operations(repository_id,lease_id,generation)
      VALUES(NEW.repository_id,NEW.lease_id,1)
      ON CONFLICT(repository_id,lease_id) DO UPDATE SET generation=generation+1;
    END`
  yield* sql`CREATE TRIGGER sandbox_cleanup_state_fence AFTER UPDATE OF state ON sandbox_cleanup_runs
    WHEN NEW.state != OLD.state
    BEGIN
      UPDATE sandbox_lease_operations SET generation=generation+1
      WHERE repository_id=NEW.repository_id AND lease_id=NEW.lease_id;
    END`
  yield* sql`CREATE TRIGGER sandbox_lease_custody_fence AFTER UPDATE ON sandbox_leases
    WHEN NEW.state != OLD.state OR NEW.actions_run_id IS NOT OLD.actions_run_id
      OR NEW.session_id IS NOT OLD.session_id
      OR (NEW.release_error IS 'Sandbox session cleanup unconfirmed; retry required')
        IS NOT (OLD.release_error IS 'Sandbox session cleanup unconfirmed; retry required')
    BEGIN
      UPDATE sandbox_lease_operations SET generation=generation+1
      WHERE repository_id=json_extract(NEW.policy,'$.repositoryId') AND lease_id=NEW.lease_id;
    END`
})

export const sandboxCreationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE sandbox_lease_operations ADD COLUMN creation_pending INTEGER NOT NULL DEFAULT 0 CHECK(creation_pending IN (0,1))`
  // An existing in-flight acquisition may already have submitted a POST.
  yield* sql`UPDATE sandbox_lease_operations SET creation_pending=1
    WHERE owner IS NOT NULL AND EXISTS (SELECT 1 FROM sandbox_leases l
      WHERE l.lease_id=sandbox_lease_operations.lease_id AND l.state='starting'
      AND json_extract(l.policy,'$.repositoryId')=sandbox_lease_operations.repository_id)`
})

// Metadata only. Historical patch captures intentionally receive no publication intent.
export const sandboxPublishMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE sandbox_publications (
    run_id TEXT PRIMARY KEY,
    actions_run_id INTEGER NOT NULL CHECK(actions_run_id > 0),
    attempt INTEGER NOT NULL CHECK(attempt = 1),
    metadata TEXT NOT NULL CHECK(json_valid(metadata)),
    phase TEXT NOT NULL CHECK(phase IN ('sealed','approving','approved','probed','operator_required','cancelled')),
    artifact_id INTEGER CHECK(artifact_id > 0),
    artifact_digest TEXT,
    deadline INTEGER NOT NULL,
    CHECK((artifact_id IS NULL) = (artifact_digest IS NULL)),
    CHECK(phase NOT IN ('approving','approved','probed') OR artifact_id IS NOT NULL)
  ) STRICT`
  yield* sql`CREATE TRIGGER sandbox_publish_immutable BEFORE UPDATE ON sandbox_publications
    WHEN NEW.run_id != OLD.run_id OR NEW.actions_run_id != OLD.actions_run_id
      OR NEW.attempt != OLD.attempt OR NEW.metadata != OLD.metadata OR NEW.deadline != OLD.deadline
      OR (OLD.artifact_id IS NOT NULL AND (NEW.artifact_id IS NOT OLD.artifact_id OR NEW.artifact_digest IS NOT OLD.artifact_digest))
    BEGIN SELECT RAISE(ABORT,'immutable publication intent'); END`
})

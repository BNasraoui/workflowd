import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

// Child tables reference capability_bindings; listed parent-first so drops run in reverse.
const children = ["capability_tokens"]

/**
 * A binding made by the gateway's own session has no SSH transport, so its transport digest is
 * absent. It counts its sessions and challenges; each run token belongs to one session, and each
 * proof (by jti) opens at most one. SQLite cannot relax a column in place, and with foreign keys on it rewrites a child's
 * reference on any rename and counts the rows a dropped parent still has. So the parent and its
 * children are copied aside, dropped children first, recreated parent first (the children from
 * their stored definitions) and refilled, all inside the migration's transaction.
 */
export const capabilitySession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const definitions = yield* sql<{
    readonly type: string
    readonly name: string
    readonly sql: string
  }>`
    SELECT type,name,sql FROM sqlite_master
    WHERE tbl_name IN ${sql.in(children)} AND type IN ('table','index') AND sql IS NOT NULL`
  const tables = ["capability_bindings", ...children]
  for (const table of tables)
    yield* sql.unsafe(`CREATE TEMP TABLE session_copy_${table} AS SELECT * FROM ${table}`)
  yield* sql`DROP TRIGGER capability_run_revoke`
  yield* sql`DROP TRIGGER capability_lease_revoke`
  for (const table of [...tables].reverse()) yield* sql.unsafe(`DROP TABLE ${table}`)
  yield* sql`CREATE TABLE capability_bindings (
    run_id TEXT PRIMARY KEY REFERENCES kernel_agent_runs(run_id),
    channel TEXT NOT NULL UNIQUE CHECK(length(channel)=64),
    challenge TEXT NOT NULL UNIQUE CHECK(length(challenge)=64),
    challenge_expires INTEGER NOT NULL,
    authority TEXT NOT NULL CHECK(json_valid(authority)),
    transport_digest TEXT CHECK(transport_digest IS NULL OR length(transport_digest)=64),
    jti_digest TEXT UNIQUE CHECK(jti_digest IS NULL OR length(jti_digest)=64),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
  ) STRICT`
  for (const table of children) {
    const definition = definitions.find((row) => row.type === "table" && row.name === table)
    if (!definition) return yield* Effect.die(new Error(`missing definition of ${table}`))
    yield* sql.unsafe(definition.sql)
  }
  for (const definition of definitions.filter((row) => row.type === "index"))
    yield* sql.unsafe(definition.sql)
  for (const table of tables) {
    yield* sql.unsafe(`INSERT INTO ${table} SELECT * FROM session_copy_${table}`)
    yield* sql.unsafe(`DROP TABLE session_copy_${table}`)
  }
  yield* sql`ALTER TABLE capability_bindings ADD COLUMN session INTEGER NOT NULL DEFAULT 0 CHECK(session>=0)`
  yield* sql`ALTER TABLE capability_bindings ADD COLUMN challenges INTEGER NOT NULL DEFAULT 0 CHECK(challenges>=0)`
  yield* sql`ALTER TABLE capability_tokens ADD COLUMN session INTEGER NOT NULL DEFAULT 0 CHECK(session>=0)`
  yield* sql`CREATE TABLE capability_proofs (
    jti_digest TEXT PRIMARY KEY CHECK(length(jti_digest)=64),
    run_id TEXT NOT NULL REFERENCES capability_bindings(run_id)
  ) STRICT`
  yield* sql`CREATE TRIGGER capability_run_revoke AFTER UPDATE OF state,attempt ON kernel_agent_runs
    WHEN NEW.state NOT IN ('spawning','spawned','verified') OR NEW.attempt != OLD.attempt
    BEGIN UPDATE capability_bindings SET revoked=1 WHERE run_id=NEW.run_id; END`
  yield* sql`CREATE TRIGGER capability_lease_revoke AFTER UPDATE OF state,actions_run_id,actions_attempt ON sandbox_leases
    WHEN NEW.state NOT IN ('starting','ready') OR NEW.actions_run_id IS NOT OLD.actions_run_id OR NEW.actions_attempt IS NOT OLD.actions_attempt
    BEGIN UPDATE capability_bindings SET revoked=1 WHERE run_id=NEW.run_id; END`
})

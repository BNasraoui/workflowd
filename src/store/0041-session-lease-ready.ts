import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

const sshReady =
  "CHECK(state != 'ready' OR (actions_run_id IS NOT NULL AND peer_id IS NOT NULL AND transport IS NOT NULL))"
const sessionReady = `CHECK(state != 'ready' OR (actions_run_id IS NOT NULL AND ((peer_id IS NOT NULL AND transport IS NOT NULL) OR coalesce(json_extract(policy,'$.privateBootstrap.mode'),'')='actions-native')))`

/**
 * An actions-native lease becomes ready when its runner opens a gateway session, with no SSH peer
 * or transport. SQLite cannot change a CHECK in place, and no table references sandbox_leases, so
 * the table alone is copied aside, recreated from its stored definition with the wider CHECK, and
 * refilled; its index and triggers come back from their stored definitions.
 */
export const sessionLeaseReady = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const definitions = yield* sql<{
    readonly type: string
    readonly sql: string
  }>`SELECT type,sql FROM sqlite_master WHERE tbl_name='sandbox_leases' AND sql IS NOT NULL`
  const table = definitions.find((row) => row.type === "table")?.sql
  if (table?.includes(sshReady) !== true)
    return yield* Effect.die(new Error("sandbox_leases readiness check not found"))
  yield* sql`CREATE TEMP TABLE ready_copy_sandbox_leases AS SELECT * FROM sandbox_leases`
  yield* sql`DROP TABLE sandbox_leases`
  yield* sql.unsafe(table.replace(sshReady, sessionReady))
  yield* sql`INSERT INTO sandbox_leases SELECT * FROM ready_copy_sandbox_leases`
  yield* sql`DROP TABLE ready_copy_sandbox_leases`
  for (const definition of definitions.filter((row) => row.type !== "table"))
    yield* sql.unsafe(definition.sql)
})

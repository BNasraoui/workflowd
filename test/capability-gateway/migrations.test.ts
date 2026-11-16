import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { gatewayMigrationsTable } from "../../src/capability-control/protocol"
import { runGatewayMigrations } from "../../src/capability-gateway/migrations"

test("the gateway's store runs its migrations in order: the capability store, the usage of each run, the session key", async () => {
  const applied = await Effect.runPromise(
    Effect.gen(function* () {
      yield* runGatewayMigrations
      const sql = yield* SqlClient.SqlClient
      return yield* sql`SELECT migration_id, name FROM ${sql(gatewayMigrationsTable)} ORDER BY migration_id`
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
  expect(applied).toEqual([
    { migration_id: 1, name: "capability_store" },
    { migration_id: 2, name: "run_usage" },
    { migration_id: 3, name: "session_key" },
  ])
})

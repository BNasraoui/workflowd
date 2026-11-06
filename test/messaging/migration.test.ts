import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { runStoreMigrations, runStoreMigrationsThrough0038 } from "../../src/store/migrations"

test("real SQLite upgrade from 38 and reopen preserve historical custody, proof and uncertain inbox facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-message-upgrade-"))
  const file = join(root, "historical.db")
  try {
    const before = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runStoreMigrationsThrough0038
        yield* sql`INSERT INTO directory_local_identity VALUES(1,'host-a')`
        yield* sql`INSERT INTO directory_managed VALUES('historical','managed:host-a:historical','host-a',7,'native','/historical','2026-10-01T00:00:00.000Z','2026-10-01T00:01:00.000Z')`
        yield* sql`INSERT INTO resident_threads(run_id,thread_id,directory,state,closure_confirmed) VALUES('historical','native','/historical','operator_required',0)`
        yield* sql`INSERT INTO resident_servers VALUES('historical','historical-owned-unit','launch-proof','invocation-proof','/historical/socket','active')`
        for (const state of ["prepared", "sending", "delivered", "operator_required"])
          yield* sql`INSERT INTO resident_inbox(id,thread_id,prompt,state,not_before) VALUES(${state},'native','historical input',${state},123)`
        return {
          directory: yield* sql`SELECT * FROM directory_managed`,
          threads: yield* sql`SELECT * FROM resident_threads`,
          servers: yield* sql`SELECT * FROM resident_servers`,
          inbox: yield* sql`SELECT * FROM resident_inbox ORDER BY id`,
        }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: file }))),
    )
    for (let reopen = 0; reopen < 2; reopen++)
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          expect((yield* runStoreMigrations).map((migration) => migration[0])).toEqual(
            reopen === 0 ? [39] : [],
          )
          expect({
            directory: yield* sql`SELECT * FROM directory_managed`,
            threads: yield* sql`SELECT * FROM resident_threads`,
            servers: yield* sql`SELECT * FROM resident_servers`,
            inbox: yield* sql`SELECT * FROM resident_inbox ORDER BY id`,
          }).toEqual(before)
          expect(yield* sql`SELECT * FROM agent_messages`).toEqual([])
        }).pipe(Effect.provide(SqliteClient.layer({ filename: file }))),
      )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

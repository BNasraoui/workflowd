import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Migrator, SqlClient } from "effect/unstable/sql"
import { gatewayMigrationsTable } from "../../src/capability-control/protocol"
import { gatewayMigrations, runGatewayMigrations } from "../../src/capability-gateway/migrations"
import { maxRenewalAttempt } from "../../deploy/sandbox/renewal.mjs"

test("the gateway's store runs its migrations in order: the capability store, the usage of each run, the session key, the records of runner runs, the head of each run's events", async () => {
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
    { migration_id: 4, name: "run_records" },
    { migration_id: 5, name: "run_event_heads" },
  ])
})

test("the migration of the event heads holds the last sequence and the bytes of the events of each run that the store held before it", async () => {
  const heads = await Effect.runPromise(
    Effect.gen(function* () {
      const { "0005_run_event_heads": _heads, ...before } = gatewayMigrations
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(before),
        table: gatewayMigrationsTable,
      })
      const sql = yield* SqlClient.SqlClient
      for (const run of ["one", "two", "none"])
        yield* sql`INSERT INTO capability_grants(run_id,lease_id,grant_json) VALUES(${run},${run},'{}')`
      yield* sql`INSERT INTO capability_run_events(run_id,sequence,lines,bytes)
        VALUES('one',1,'[]',2),('one',2,'["a"]',5),('two',1,'["bc"]',6)`
      yield* runGatewayMigrations
      return yield* sql`SELECT run_id AS runId,last,total FROM capability_run_event_heads ORDER BY run_id`
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
  expect(heads).toEqual([
    { runId: "one", last: 2, total: 7 },
    { runId: "two", last: 1, total: 6 },
  ])
})

test("the store keeps only a closed end reason, on a revoked run; a first call's time after 0; and a renewal attempt number from 0 to its bound", async () => {
  const results = await Effect.runPromise(
    Effect.gen(function* () {
      yield* runGatewayMigrations
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO capability_grants(run_id,lease_id,grant_json) VALUES('run','lease','{}')`
      yield* sql`INSERT INTO capability_bindings(run_id,channel,challenge,challenge_expires,authority)
        VALUES('run',${"c".repeat(64)},${"d".repeat(64)},0,'{}')`
      yield* sql`INSERT INTO capability_tokens(digest,run_id,expires_at) VALUES(${"a".repeat(64)},'run',1)`
      const outcome = (statement: Effect.Effect<unknown, unknown>) =>
        Effect.match(statement, { onFailure: () => "refused", onSuccess: () => "kept" })
      return {
        otherReason: yield* outcome(
          sql`UPDATE capability_grants SET revoked=1,end_reason='budget' WHERE run_id='run'`,
        ),
        liveRunReason: yield* outcome(
          sql`UPDATE capability_grants SET end_reason='two holders' WHERE run_id='run'`,
        ),
        revokedRunReason: yield* outcome(
          sql`UPDATE capability_grants SET revoked=1,end_reason='two holders' WHERE run_id='run'`,
        ),
        usedAtZero: yield* outcome(sql`UPDATE capability_tokens SET used_at=0`),
        usedAt: yield* outcome(sql`UPDATE capability_tokens SET used_at=1`),
        attemptBelow: yield* outcome(sql`UPDATE capability_bindings SET renewal_attempt=-1`),
        attemptBound: yield* outcome(
          sql`UPDATE capability_bindings SET renewal_attempt=${maxRenewalAttempt}`,
        ),
        attemptAbove: yield* outcome(
          sql`UPDATE capability_bindings SET renewal_attempt=${maxRenewalAttempt + 1}`,
        ),
        // A binding has no session key until a session binds one: it renews nothing.
        sessionKey: yield* sql`SELECT session_key AS sessionKey FROM capability_bindings`,
      }
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
  expect(results).toEqual({
    otherReason: "refused",
    liveRunReason: "refused",
    revokedRunReason: "kept",
    usedAtZero: "refused",
    usedAt: "kept",
    attemptBelow: "refused",
    attemptBound: "kept",
    attemptAbove: "refused",
    sessionKey: [{ sessionKey: null }],
  })
})

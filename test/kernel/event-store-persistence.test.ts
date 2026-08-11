import { expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { KernelEventStore, KernelEventStoreLive } from "../../src/kernel/event-store"
import { WorkflowStoreLive } from "../../src/store"
import { runWithStore } from "../store/harness"

const createdAt = new Date("2026-08-11T09:00:00.000Z")
const instance = {
  instanceId: "instance-1",
  workflowType: "review",
  workflowVersion: 2,
  workflowKey: "repo:42:pr:7",
  payload: { repositoryId: 42 },
  createdAt,
}
const event = {
  instanceId: "instance-1",
  dedupeKey: "restart-event",
  event: { type: "signal", version: 1, key: "key", payload: { ok: true } },
  recordedAt: createdAt,
}
const wait = {
  instanceId: "instance-1",
  waitId: "restart-wait",
  condition: { type: "signal", version: 1, key: "key" },
  afterSequence: 0,
  registeredAt: createdAt,
}

test("owns four strict SQLite tables in migration 11", async () => {
  const result = await runWithStore(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 11
      `
      const tables = yield* sql<{ readonly name: string; readonly strict: number }>`
        SELECT name, strict FROM pragma_table_list
        WHERE name IN (
          'kernel_workflow_instances', 'kernel_events', 'kernel_waits',
          'kernel_wait_event_deliveries'
        )
        ORDER BY name
      `
      return { migrations, tables }
    }),
  )

  expect(result.migrations).toEqual([{ migration_id: 11, name: "kernel_event_wait_store" }])
  expect(result.tables).toHaveLength(4)
  expect(result.tables.every(({ strict }) => strict === 1)).toBe(true)
})

test("upgrades and restarts a file database without losing existing tables or records", async () => {
  const filename = `${process.cwd()}/kernel-event-store-${crypto.randomUUID()}.sqlite`
  try {
    const firstDatabase = SqliteClient.layer({ filename })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO webhook_deliveries (
          delivery_id, event, action, payload, received_at, observation_sequence
        ) VALUES ('preserved', 'push', NULL, '{}', ${createdAt.toISOString()}, 1)`
        yield* sql`DROP TABLE kernel_wait_event_deliveries`
        yield* sql`DROP TABLE kernel_waits`
        yield* sql`DROP TRIGGER kernel_events_immutable_update`
        yield* sql`DROP TRIGGER kernel_events_immutable_delete`
        yield* sql`DROP TABLE kernel_events`
        yield* sql`DROP TABLE kernel_workflow_instances`
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 11`
      }).pipe(Effect.provide(WorkflowStoreLive.pipe(Layer.provideMerge(firstDatabase)))),
    )

    const secondDatabase = SqliteClient.layer({ filename })
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance)
        yield* store.recordEvent(event)
        yield* store.registerWait(wait)
      }).pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(secondDatabase)))),
    )

    const thirdDatabase = SqliteClient.layer({ filename })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        const replay = yield* store.registerWait(wait)
        const preserved = yield* sql`SELECT delivery_id FROM webhook_deliveries
          WHERE delivery_id = 'preserved'`
        const migration = yield* sql`SELECT name FROM effect_sql_migrations
          WHERE migration_id = 11`
        return { replay, preserved, migration }
      }).pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(thirdDatabase)))),
    )

    expect(result.replay.status).toBe("duplicate")
    expect(result.replay.deliveries).toHaveLength(1)
    expect(result.preserved).toEqual([{ delivery_id: "preserved" }])
    expect(result.migration).toEqual([{ name: "kernel_event_wait_store" }])
  } finally {
    await Bun.file(filename)
      .delete()
      .catch(() => undefined)
    await Bun.file(`${filename}-shm`)
      .delete()
      .catch(() => undefined)
    await Bun.file(`${filename}-wal`)
      .delete()
      .catch(() => undefined)
  }
})

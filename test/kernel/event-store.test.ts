import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import {
  KernelEventStore,
  KernelEventStoreLive,
  type KernelEventStorePort,
} from "../../src/kernel/event-store"
import { WorkflowStoreLive } from "../../src/store"

const timestamp = new Date("2026-08-11T09:00:00.000Z")
const instance = (instanceId = "instance-1") => ({
  instanceId,
  workflowType: "review",
  workflowVersion: 1,
  workflowKey: "repo:42:pr:7",
  payload: { repositoryId: 42 },
  createdAt: timestamp,
})
const event = (sourceEventId: string) => ({
  source: "github",
  sourceEventId,
  event: { type: "approval", version: 1, correlation: "gate-7", payload: { ok: true } },
  recordedAt: timestamp,
})
const wait = (waitId: string) => ({
  instanceId: "instance-1",
  waitId,
  condition: { type: "approval", version: 1, correlation: "gate-7" },
  registeredAt: timestamp,
})

const runKernel = <A, E>(effect: Effect.Effect<A, E, KernelEventStorePort | SqlClientService>) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  return Effect.runPromise(
    effect.pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap)))),
  )
}

describe("kernel event store replay", () => {
  test("idempotently creates a versioned instance and preserves its boundary", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const first = yield* store.createInstance(instance())
        yield* store.recordEvent(event("later"))
        const replay = yield* store.createInstance(instance())
        return { first, replay }
      }),
    )

    expect(result.first.status).toBe("created")
    expect(result.replay.status).toBe("duplicate")
    expect(result.replay.instance.startSequence).toBe(result.first.instance.startSequence)
  })

  test("rejects conflicting instance identity reuse", async () => {
    const error = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance())
        return yield* store.createInstance({ ...instance(), workflowVersion: 2 }).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({ _tag: "KernelStoreConflictError", record: "instance" })
  })

  test("idempotently replays canonical event payloads", async () => {
    const statuses = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const first = yield* store.recordEvent({
          ...event("canonical"),
          event: { ...event("canonical").event, payload: { b: 2, a: 1 } },
        })
        const replay = yield* store.recordEvent({
          ...event("canonical"),
          event: { ...event("canonical").event, payload: { a: 1, b: 2 } },
        })
        return [first.status, replay.status, replay.event.sequence]
      }),
    )

    expect(statuses).toEqual(["recorded", "duplicate", 1])
  })

  test("rejects changed content under one source identity", async () => {
    const error = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.recordEvent(event("conflict"))
        return yield* store
          .recordEvent({
            ...event("conflict"),
            event: { ...event("conflict").event, payload: { ok: false } },
          })
          .pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({ _tag: "KernelStoreConflictError", record: "event" })
  })

  test("idempotently replays a wait and rejects changed conditions", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance())
        const first = yield* store.registerWait(wait("replay"))
        const replay = yield* store.registerWait(wait("replay"))
        const conflict = yield* store
          .registerWait({
            ...wait("replay"),
            condition: { ...wait("replay").condition, correlation: "other" },
          })
          .pipe(Effect.flip)
        return { first, replay, conflict }
      }),
    )

    expect([result.first.status, result.replay.status]).toEqual(["registered", "duplicate"])
    expect(result.conflict).toMatchObject({ _tag: "KernelStoreConflictError", record: "wait" })
  })

  test("unrelated malformed wait data fails closed", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const invalid = yield* store
          .registerWait({
            ...wait("invalid"),
            condition: { ...wait("invalid").condition, version: 0 },
          })
          .pipe(Effect.either)
        const missingParent = yield* store
          .registerWait({ ...wait("missing"), instanceId: "missing-instance" })
          .pipe(Effect.either)
        return { invalid, missingParent }
      }),
    )

    expect(result.invalid._tag).toBe("Left")
    expect(result.missingParent._tag).toBe("Left")
  })
})

describe("kernel malformed rows and rollback", () => {
  test("reports malformed instance rows as typed data errors", async () => {
    const error = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`INSERT INTO kernel_workflow_instances (
          instance_id, workflow_type, workflow_version, workflow_key, payload_json,
          start_sequence, created_at
        ) VALUES ('instance-1', 'review', 1, 'repo', '{}', -1, ${timestamp.toISOString()})`
        return yield* store.createInstance(instance()).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({ _tag: "KernelStoreDataError", record: "instance" })
  })

  test("rolls back wait registration when its earliest event is malformed", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instance())
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`INSERT INTO kernel_events (
          sequence, source, source_event_id, event_type, event_version, correlation,
          payload_json, recorded_at
        ) VALUES (1, 'github', 'malformed', 'approval', 1, 'gate-7', '{bad',
          ${timestamp.toISOString()})`
        const error = yield* store.registerWait(wait("rollback-wait")).pipe(Effect.flip)
        const rows = yield* sql`SELECT wait_id FROM kernel_waits WHERE wait_id = 'rollback-wait'`
        return { error, rows }
      }),
    )

    expect(result.error).toMatchObject({ _tag: "KernelStoreDataError", record: "event" })
    expect(result.rows).toEqual([])
  })

  test("rolls back event recording when a pending wait is malformed", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instance())
        yield* sql`INSERT INTO kernel_waits (
          instance_id, wait_id, event_type, event_version, correlation,
          after_sequence, registered_at
        ) VALUES ('instance-1', 'malformed-wait', 'approval', 1, 'gate-7', 0, 'bad-date')`
        const error = yield* store.recordEvent(event("rollback-event")).pipe(Effect.flip)
        const rows = yield* sql`SELECT sequence FROM kernel_events
          WHERE source_event_id = 'rollback-event'`
        return { error, rows }
      }),
    )

    expect(result.error).toMatchObject({ _tag: "KernelStoreDataError", record: "wait" })
    expect(result.rows).toEqual([])
  })

  test("reports malformed ready deliveries as typed data errors", async () => {
    const error = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instance())
        const recorded = yield* store.recordEvent(event("bad-delivery-event"))
        yield* sql`PRAGMA foreign_keys = OFF`
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`INSERT INTO kernel_wait_event_deliveries (
          instance_id, wait_id, event_sequence, delivered_at
        ) VALUES ('instance-1', '', ${recorded.event.sequence}, ${timestamp.toISOString()})`
        return yield* store.readReadyDeliveries("instance-1").pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({ _tag: "KernelStoreDataError", record: "delivery" })
  })
})

describe("kernel byte envelopes", () => {
  test("bounds wait identifiers by exact UTF-8 bytes", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance())
        const exact = yield* store.registerWait({ ...wait("é".repeat(128)) }).pipe(Effect.either)
        const oversized = yield* store
          .registerWait({ ...wait(`${"é".repeat(128)}a`) })
          .pipe(Effect.either)
        return { exact, oversized }
      }),
    )

    expect(result.exact._tag).toBe("Right")
    expect(result.oversized._tag).toBe("Left")
  })

  test("accepts exact ASCII and Unicode byte maxima", async () => {
    const statuses = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const ascii = yield* store.recordEvent({
          source: "s".repeat(128),
          sourceEventId: "i".repeat(256),
          event: {
            type: "t".repeat(128),
            version: 1,
            correlation: "c".repeat(256),
            payload: "p".repeat(65_534),
          },
          recordedAt: timestamp,
        })
        const unicode = yield* store.recordEvent({
          source: "é".repeat(64),
          sourceEventId: "é".repeat(128),
          event: {
            type: "é".repeat(64),
            version: 1,
            correlation: "é".repeat(128),
            payload: "é".repeat(32_767),
          },
          recordedAt: timestamp,
        })
        return [ascii.status, unicode.status]
      }),
    )

    expect(statuses).toEqual(["recorded", "recorded"])
  })

  test("rejects every max-plus-one durable event field", async () => {
    const tags = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const base = event("bounded")
        const results = yield* Effect.all([
          store.recordEvent({ ...base, source: `${"é".repeat(64)}a` }).pipe(Effect.either),
          store.recordEvent({ ...base, sourceEventId: `${"é".repeat(128)}a` }).pipe(Effect.either),
          store
            .recordEvent({
              ...base,
              event: { ...base.event, type: `${"é".repeat(64)}a` },
            })
            .pipe(Effect.either),
          store
            .recordEvent({
              ...base,
              event: { ...base.event, correlation: `${"é".repeat(128)}a` },
            })
            .pipe(Effect.either),
          store
            .recordEvent({
              ...base,
              event: { ...base.event, payload: "p".repeat(65_535) },
            })
            .pipe(Effect.either),
        ])
        return results.map((result) => (result._tag === "Left" ? result.left._tag : result._tag))
      }),
    )

    expect(tags).toEqual(Array.from({ length: 5 }, () => "KernelStoreInputError"))
  })
})

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

const createdAt = new Date("2026-08-11T09:00:00.000Z")
const instanceInput = {
  instanceId: "instance-1",
  workflowType: "review",
  workflowVersion: 2,
  workflowKey: "repo:42:pr:7",
  payload: { repositoryId: 42 },
  createdAt,
}

const runWithKernelStore = <A, E>(
  effect: Effect.Effect<A, E, KernelEventStorePort | SqlClientService>,
) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  return Effect.runPromise(
    effect.pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(database)))),
  )
}

describe("kernel event store", () => {
  test("exposes a dedicated Effect store port", async () => {
    const module = await import("../../src/kernel/event-store").catch(() => null)

    expect(module).not.toBeNull()
    expect(module !== null && "KernelEventStore" in module).toBe(true)
    expect(module !== null && "KernelEventStoreLive" in module).toBe(true)
  })

  test("keeps instance creation on the kernel port", async () => {
    const hasMethod = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        return typeof Reflect.get(store, "createInstance") === "function"
      }),
    )

    expect(hasMethod).toBe(true)
  })

  test("keeps event recording and wait registration on the kernel port", async () => {
    const methods = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        return ["recordEvent", "registerWait"].map(
          (name) => typeof Reflect.get(store, name) === "function",
        )
      }),
    )

    expect(methods).toEqual([true, true])
  })

  test("creates and idempotently replays a versioned workflow instance", async () => {
    const input = instanceInput
    const results = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        return [yield* store.createInstance(input), yield* store.createInstance(input)]
      }),
    )

    expect(results).toEqual([
      { status: "created", instance: input },
      { status: "duplicate", instance: input },
    ])
  })

  test("atomically delivers a later exact event to a registered wait", async () => {
    const wait = {
      instanceId: instanceInput.instanceId,
      waitId: "wait-1",
      condition: { type: "approval", version: 1, key: "gate-7" },
      afterSequence: 0,
      registeredAt: new Date("2026-08-11T09:01:00.000Z"),
    }
    const event = {
      instanceId: instanceInput.instanceId,
      dedupeKey: "github-delivery-1",
      event: {
        type: "approval",
        version: 1,
        key: "gate-7",
        payload: { action: "approve" },
      },
      recordedAt: new Date("2026-08-11T09:02:00.000Z"),
    }
    const results = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instanceInput)
        return [yield* store.registerWait(wait), yield* store.recordEvent(event)]
      }),
    )

    expect(results).toEqual([
      { status: "registered", wait, deliveries: [] },
      {
        status: "recorded",
        event: { ...event, sequence: 1 },
        deliveries: [{ instanceId: "instance-1", waitId: "wait-1", eventSequence: 1 }],
      },
    ])
  })

  test("atomically delivers an existing exact event when registering a wait", async () => {
    const event = {
      instanceId: instanceInput.instanceId,
      dedupeKey: "github-delivery-before",
      event: { type: "approval", version: 1, key: "gate-7", payload: { action: "approve" } },
      recordedAt: new Date("2026-08-11T09:02:00.000Z"),
    }
    const wait = {
      instanceId: instanceInput.instanceId,
      waitId: "wait-after",
      condition: { type: "approval", version: 1, key: "gate-7" },
      afterSequence: 0,
      registeredAt: new Date("2026-08-11T09:03:00.000Z"),
    }
    const result = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instanceInput)
        yield* store.recordEvent(event)
        return yield* store.registerWait(wait)
      }),
    )

    expect(result).toEqual({
      status: "registered",
      wait,
      deliveries: [{ instanceId: "instance-1", waitId: "wait-after", eventSequence: 1 }],
    })
  })

  test("rejects a conflicting workflow instance replay", async () => {
    const error = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const input = {
          instanceId: "instance-conflict",
          workflowType: "review",
          workflowVersion: 1,
          workflowKey: "repo:42:pr:7",
          payload: { repositoryId: 42 },
          createdAt,
        }
        yield* store.createInstance(input)
        return yield* store.createInstance({ ...input, workflowVersion: 2 }).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({
      _tag: "KernelStoreConflictError",
      record: "instance",
      instanceId: "instance-conflict",
    })
  })

  test("reports a malformed durable instance row as a typed data error", async () => {
    const error = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_workflow_instances SET workflow_version = 0
          WHERE instance_id = ${instanceInput.instanceId}`
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        return yield* store.createInstance(instanceInput).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({
      _tag: "KernelStoreDataError",
      record: "instance",
      instanceId: "instance-1",
    })
  })

  test("reports a malformed durable event row as a typed data error", async () => {
    const event = {
      instanceId: instanceInput.instanceId,
      dedupeKey: "malformed-event",
      event: { type: "approval", version: 1, key: "gate-7", payload: { ok: true } },
      recordedAt: createdAt,
    }
    const error = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* store.recordEvent(event)
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_events SET event_version = 0
          WHERE instance_id = ${instanceInput.instanceId}`
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        return yield* store.recordEvent(event).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({
      _tag: "KernelStoreDataError",
      record: "event",
      key: "malformed-event",
    })
  })

  test("reports a malformed durable wait row as a typed data error", async () => {
    const wait = {
      instanceId: instanceInput.instanceId,
      waitId: "malformed-wait",
      condition: { type: "approval", version: 1, key: "gate-7" },
      afterSequence: 0,
      registeredAt: createdAt,
    }
    const error = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* store.registerWait(wait)
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_waits SET after_sequence = -1
          WHERE instance_id = ${instanceInput.instanceId}`
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        return yield* store.registerWait(wait).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({
      _tag: "KernelStoreDataError",
      record: "wait",
      key: "malformed-wait",
    })
  })

  test("reports a malformed durable delivery row as a typed data error", async () => {
    const wait = {
      instanceId: "instance-1",
      waitId: "malformed-delivery-wait",
      condition: { type: "signal", version: 1, key: "key" },
      afterSequence: 0,
      registeredAt: createdAt,
    }
    const error = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* store.registerWait(wait)
        yield* store.recordEvent({
          instanceId: "instance-1",
          dedupeKey: "malformed-delivery-event",
          event: { type: "signal", version: 1, key: "key", payload: null },
          recordedAt: createdAt,
        })
        yield* sql`PRAGMA foreign_keys = OFF`
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_wait_event_deliveries SET event_sequence = 0`
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        return yield* store.registerWait(wait).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({ _tag: "KernelStoreDataError", record: "delivery" })
  })

  test("rolls back wait registration when a matched event row is malformed", async () => {
    const result = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* store.recordEvent({
          instanceId: instanceInput.instanceId,
          dedupeKey: "rollback-event",
          event: { type: "approval", version: 1, key: "gate-7", payload: { ok: true } },
          recordedAt: createdAt,
        })
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_events SET payload_json = '{bad-json'
          WHERE instance_id = ${instanceInput.instanceId}`
        yield* sql`PRAGMA ignore_check_constraints = OFF`
        const error = yield* store
          .registerWait({
            instanceId: instanceInput.instanceId,
            waitId: "rolled-back-wait",
            condition: { type: "approval", version: 1, key: "gate-7" },
            afterSequence: 0,
            registeredAt: createdAt,
          })
          .pipe(Effect.flip)
        const rows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM kernel_waits WHERE wait_id = 'rolled-back-wait'`
        return { error, count: rows[0]?.count }
      }),
    )

    expect(result.error).toMatchObject({ _tag: "KernelStoreDataError", record: "event" })
    expect(result.count).toBe(0)
  })

  test("rolls back event recording when a matched wait row is malformed", async () => {
    const result = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* store.registerWait({
          instanceId: instanceInput.instanceId,
          waitId: "rollback-existing-wait",
          condition: { type: "approval", version: 1, key: "gate-7" },
          afterSequence: 0,
          registeredAt: createdAt,
        })
        yield* sql`UPDATE kernel_waits SET registered_at = 'not-a-date'
          WHERE wait_id = 'rollback-existing-wait'`
        const error = yield* store
          .recordEvent({
            instanceId: instanceInput.instanceId,
            dedupeKey: "rolled-back-event",
            event: { type: "approval", version: 1, key: "gate-7", payload: { ok: true } },
            recordedAt: createdAt,
          })
          .pipe(Effect.flip)
        const rows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM kernel_events WHERE dedupe_key = 'rolled-back-event'`
        return { error, count: rows[0]?.count }
      }),
    )

    expect(result.error).toMatchObject({ _tag: "KernelStoreDataError", record: "wait" })
    expect(result.count).toBe(0)
  })

  test("keeps typed events immutable", async () => {
    const results = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* store.recordEvent({
          instanceId: instanceInput.instanceId,
          dedupeKey: "immutable-event",
          event: { type: "approval", version: 1, key: "gate-7", payload: { ok: true } },
          recordedAt: createdAt,
        })
        return yield* Effect.all([
          sql`UPDATE kernel_events SET payload_json = '{}'`.pipe(Effect.either),
          sql`DELETE FROM kernel_events`.pipe(Effect.either),
        ])
      }),
    )

    expect(results.map((result) => result._tag)).toEqual(["Left", "Left"])
  })

  test("orders events independently within each workflow instance", async () => {
    const sequences = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const secondInstance = { ...instanceInput, instanceId: "instance-2" }
        yield* store.createInstance(instanceInput)
        yield* store.createInstance(secondInstance)
        const record = (instanceId: string, dedupeKey: string) =>
          store.recordEvent({
            instanceId,
            dedupeKey,
            event: { type: "signal", version: 1, key: "key", payload: null },
            recordedAt: createdAt,
          })
        const first = yield* record("instance-1", "one")
        const second = yield* record("instance-1", "two")
        const other = yield* record("instance-2", "one")
        return [first.event.sequence, second.event.sequence, other.event.sequence]
      }),
    )

    expect(sequences).toEqual([1, 2, 1])
  })

  test("idempotently replays an event with canonical payload ordering", async () => {
    const statuses = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instanceInput)
        const first = yield* store.recordEvent({
          instanceId: "instance-1",
          dedupeKey: "canonical",
          event: { type: "signal", version: 1, key: "key", payload: { b: 2, a: 1 } },
          recordedAt: createdAt,
        })
        const replay = yield* store.recordEvent({
          instanceId: "instance-1",
          dedupeKey: "canonical",
          event: { type: "signal", version: 1, key: "key", payload: { a: 1, b: 2 } },
          recordedAt: createdAt,
        })
        return [first.status, replay.status, replay.event.sequence]
      }),
    )

    expect(statuses).toEqual(["recorded", "duplicate", 1])
  })

  test("rejects conflicting event dedupe", async () => {
    const error = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instanceInput)
        const event = {
          instanceId: "instance-1",
          dedupeKey: "conflicting-event",
          event: { type: "signal", version: 1, key: "key", payload: { value: 1 } },
          recordedAt: createdAt,
        }
        yield* store.recordEvent(event)
        return yield* store
          .recordEvent({ ...event, event: { ...event.event, payload: { value: 2 } } })
          .pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({
      _tag: "KernelStoreConflictError",
      record: "event",
      key: "conflicting-event",
    })
  })

  test("idempotently replays waits without duplicating deliveries", async () => {
    const result = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instanceInput)
        yield* store.recordEvent({
          instanceId: "instance-1",
          dedupeKey: "wait-replay-event",
          event: { type: "signal", version: 1, key: "key", payload: null },
          recordedAt: createdAt,
        })
        const wait = {
          instanceId: "instance-1",
          waitId: "replayed-wait",
          condition: { type: "signal", version: 1, key: "key" },
          afterSequence: 0,
          registeredAt: createdAt,
        }
        const first = yield* store.registerWait(wait)
        const replay = yield* store.registerWait(wait)
        const rows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM kernel_wait_event_deliveries WHERE wait_id = 'replayed-wait'`
        return { first, replay, count: rows[0]?.count }
      }),
    )

    expect([result.first.status, result.replay.status, result.count]).toEqual([
      "registered",
      "duplicate",
      1,
    ])
  })

  test("rejects conflicting wait replay", async () => {
    const error = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instanceInput)
        const wait = {
          instanceId: "instance-1",
          waitId: "conflicting-wait",
          condition: { type: "signal", version: 1, key: "key" },
          afterSequence: 0,
          registeredAt: createdAt,
        }
        yield* store.registerWait(wait)
        return yield* store.registerWait({ ...wait, afterSequence: 1 }).pipe(Effect.flip)
      }),
    )

    expect(error).toMatchObject({
      _tag: "KernelStoreConflictError",
      record: "wait",
      key: "conflicting-wait",
    })
  })

  test("fans out exact matches while respecting nonmatches and cursor boundaries", async () => {
    const deliveries = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instanceInput)
        const register = (waitId: string, type: string, version: number, key: string, after = 0) =>
          store.registerWait({
            instanceId: "instance-1",
            waitId,
            condition: { type, version, key },
            afterSequence: after,
            registeredAt: createdAt,
          })
        yield* register("exact-a", "signal", 1, "key")
        yield* register("exact-b", "signal", 1, "key")
        yield* register("wrong-type", "other", 1, "key")
        yield* register("wrong-version", "signal", 2, "key")
        yield* register("wrong-key", "signal", 1, "other")
        yield* register("after-first", "signal", 1, "key", 1)
        const record = (dedupeKey: string) =>
          store.recordEvent({
            instanceId: "instance-1",
            dedupeKey,
            event: { type: "signal", version: 1, key: "key", payload: null },
            recordedAt: createdAt,
          })
        const first = yield* record("fanout-1")
        const second = yield* record("fanout-2")
        return [first.deliveries, second.deliveries]
      }),
    )

    expect(deliveries.map((batch) => batch.map(({ waitId }) => waitId))).toEqual([
      ["exact-a", "exact-b"],
      ["after-first", "exact-a", "exact-b"],
    ])
  })

  test("rejects out-of-envelope type, version, key, cursor, and payload values", async () => {
    const tags = await runWithKernelStore(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instanceInput)
        const event = {
          instanceId: "instance-1",
          dedupeKey: "bounded",
          event: { type: "signal", version: 1, key: "key", payload: null },
          recordedAt: createdAt,
        }
        const wait = {
          instanceId: "instance-1",
          waitId: "bounded",
          condition: { type: "signal", version: 1, key: "key" },
          afterSequence: 0,
          registeredAt: createdAt,
        }
        const results = yield* Effect.all([
          store
            .recordEvent({ ...event, event: { ...event.event, type: "t".repeat(129) } })
            .pipe(Effect.either),
          store
            .recordEvent({ ...event, event: { ...event.event, version: 0 } })
            .pipe(Effect.either),
          store
            .recordEvent({ ...event, event: { ...event.event, key: "k".repeat(257) } })
            .pipe(Effect.either),
          store
            .recordEvent({
              ...event,
              event: { ...event.event, payload: "p".repeat(65_536) },
            })
            .pipe(Effect.either),
          store.registerWait({ ...wait, afterSequence: -1 }).pipe(Effect.either),
        ])
        return results.map((result) => (result._tag === "Left" ? result.left._tag : result._tag))
      }),
    )

    expect(tags).toEqual(Array.from({ length: 5 }, () => "KernelStoreInputError"))
  })
})

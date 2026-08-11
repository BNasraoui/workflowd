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

const timestamp = new Date("2026-08-11T11:00:00.000Z")
const instance = (instanceId: string) => ({
  instanceId,
  workflowType: "review",
  workflowVersion: 1,
  workflowKey: instanceId,
  payload: null,
  createdAt: timestamp,
})
const wait = (instanceId: string, waitId: string) => ({
  instanceId,
  waitId,
  condition: { type: "approval", version: 1, correlation: "gate-7", key: "gate-7" },
  afterSequence: 0,
  registeredAt: timestamp,
})
const event = (sourceEventId: string, correlation = "gate-7", instanceId = "instance-1") => ({
  instanceId,
  dedupeKey: sourceEventId,
  source: "github",
  sourceEventId,
  event: {
    type: "approval",
    version: 1,
    correlation,
    key: correlation,
    payload: { approved: true },
  },
  recordedAt: timestamp,
})

const runKernel = <A, E>(effect: Effect.Effect<A, E, KernelEventStorePort | SqlClientService>) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  return Effect.runPromise(
    effect.pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap)))),
  )
}

const runUnmigratedKernel = <A, E>(
  effect: Effect.Effect<A, E, KernelEventStorePort | SqlClientService>,
) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  return Effect.runPromise(
    effect.pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(database)))),
  )
}

describe("one-shot global event ledger corrections", () => {
  test("a matched wait is not delivered again by a later event", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-1"))
        yield* store.registerWait(wait("instance-1", "wait-1"))
        const first = yield* store.recordEvent(event("event-1"))
        const second = yield* store.recordEvent(event("event-2"))
        return { first, second }
      }),
    )

    expect(result.first.deliveries).toHaveLength(1)
    expect(result.second.deliveries).toEqual([])
  })

  test("event-before-wait chooses only the earliest eligible event", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-1"))
        yield* store.recordEvent(event("event-1"))
        yield* store.recordEvent(event("event-2"))
        return yield* store.registerWait(wait("instance-1", "wait-1"))
      }),
    )

    expect(result.deliveries.map(({ eventSequence }) => eventSequence)).toEqual([1])
  })

  test("two waits in different instances receive one shared global event", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-a"))
        yield* store.createInstance(instance("instance-b"))
        yield* store.registerWait(wait("instance-a", "wait-a"))
        yield* store.registerWait(wait("instance-b", "wait-b"))
        return yield* store.recordEvent(event("shared", "gate-7", "instance-a"))
      }),
    )

    expect(result.deliveries.map(({ instanceId }) => instanceId)).toEqual([
      "instance-a",
      "instance-b",
    ])
  })

  test("an unrelated global event does not match a pending wait", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-1"))
        yield* store.registerWait(wait("instance-1", "wait-1"))
        return yield* store.recordEvent(event("unrelated", "another-gate"))
      }),
    )

    expect(result.deliveries).toEqual([])
  })

  test("new instances derive a high-water boundary and skip older facts", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("source-instance"))
        yield* store.recordEvent(event("before-instance", "gate-7", "source-instance"))
        const created = yield* store.createInstance(instance("instance-1"))
        const registered = yield* store.registerWait(wait("instance-1", "wait-1"))
        return { created, registered }
      }).pipe(Effect.either),
    )

    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.created.instance.eventCursor).toBe(1)
      expect(result.right.registered.deliveries).toEqual([])
    }
  })

  test("ready deliveries are queryable without replay", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-1"))
        yield* store.registerWait(wait("instance-1", "wait-1"))
        yield* store.recordEvent(event("ready"))
        return typeof Reflect.get(store, "readReadyDeliveries")
      }),
    )

    expect(result).toBe("function")
  })

  test("the kernel layer does not run production migrations", async () => {
    const count = await runUnmigratedKernel(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
          FROM sqlite_master WHERE name LIKE 'kernel_%'`
        return rows[0]?.count
      }),
    )

    expect(count).toBe(0)
  })

  test("event immutability remains enforced with check constraints ignored", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instance("instance-1"))
        yield* store.recordEvent(event("immutable"))
        yield* sql`PRAGMA ignore_check_constraints = ON`
        return yield* Effect.all([
          sql`UPDATE kernel_events SET payload_json = '{}'`.pipe(Effect.either),
          sql`DELETE FROM kernel_events`.pipe(Effect.either),
        ])
      }),
    )

    expect(result.map(({ _tag }) => _tag)).toEqual(["Left", "Left"])
  })

  test("event immutability rejects replacement writes", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        const recorded = yield* store.recordEvent(event("replace-target"))
        return yield* sql`INSERT OR REPLACE INTO kernel_events (
          sequence, source, source_event_id, event_type, event_version, event_key, correlation,
          payload_json, recorded_at
        ) VALUES (
          ${recorded.event.sequence}, 'github', 'replace-target', 'approval', 1, 'gate-7',
          'gate-7', '{"approved":false}', ${timestamp.toISOString()}
        )`.pipe(Effect.either)
      }),
    )

    expect(result._tag).toBe("Left")
  })

  test("event immutability rejects identical replacement without a sequence", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.recordEvent(event("replace-identical"))
        return yield* sql`INSERT OR REPLACE INTO kernel_events (
          source, source_event_id, event_type, event_version, event_key, correlation,
          payload_json, recorded_at
        ) VALUES (
          'github', 'replace-identical', 'approval', 1, 'gate-7', 'gate-7',
          '{"approved":true}', ${timestamp.toISOString()}
        )`.pipe(Effect.either)
      }),
    )

    expect(result._tag).toBe("Left")
  })

  test("event immutability rejects timestamp-only raw replacement", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        const recorded = yield* store.recordEvent(event("replace-timestamp"))
        return yield* sql`INSERT OR REPLACE INTO kernel_events (
          sequence, source, source_event_id, event_type, event_version, event_key, correlation,
          payload_json, recorded_at
        ) VALUES (
          ${recorded.event.sequence}, 'github', 'replace-timestamp', 'approval', 1,
          'gate-7', 'gate-7', '{"approved":true}', '2026-08-11T12:00:00.000Z'
        )`.pipe(Effect.either)
      }),
    )

    expect(result._tag).toBe("Left")
  })

  test("durable text bounds count UTF-8 bytes rather than characters", async () => {
    const result = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const exactInstance = "é".repeat(128)
        const accepted = yield* store.createInstance(instance(exactInstance)).pipe(Effect.either)
        const rejected = yield* store
          .createInstance(instance(`${exactInstance}a`))
          .pipe(Effect.either)
        return { accepted, rejected }
      }),
    )

    expect(result.accepted._tag).toBe("Right")
    expect(result.rejected._tag).toBe("Left")
    if (result.rejected._tag === "Left") {
      expect(result.rejected.left._tag).toBe("KernelStoreInputError")
    }
  })

  test("SQLite enforces byte bounds independently of the Effect port", async () => {
    const tags = await runKernel(
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        yield* store.createInstance(instance("instance-1"))
        const insertEvent = (overrides: {
          readonly sequence: number
          readonly source?: string
          readonly sourceEventId?: string
          readonly type?: string
          readonly key?: string
          readonly correlation?: string
          readonly payload?: string
        }) => sql`
          INSERT INTO kernel_events (
            sequence, source, source_event_id, event_type, event_version, event_key, correlation,
            payload_json, recorded_at
          ) VALUES (
            ${overrides.sequence},
            ${overrides.source ?? "source"},
            ${overrides.sourceEventId ?? crypto.randomUUID()},
            ${overrides.type ?? "type"}, 1, ${overrides.key ?? "key"},
            ${overrides.correlation ?? "correlation"},
            ${overrides.payload ?? "null"}, ${timestamp.toISOString()}
          )
        `
        const results = yield* Effect.all([
          insertEvent({ sequence: 100, source: `${"é".repeat(64)}a` }).pipe(Effect.either),
          insertEvent({ sequence: 101, sourceEventId: `${"é".repeat(128)}a` }).pipe(Effect.either),
          insertEvent({ sequence: 102, type: `${"é".repeat(64)}a` }).pipe(Effect.either),
          insertEvent({ sequence: 103, key: `${"é".repeat(128)}a` }).pipe(Effect.either),
          insertEvent({ sequence: 104, correlation: `${"é".repeat(128)}a` }).pipe(Effect.either),
          insertEvent({ sequence: 105, payload: JSON.stringify("p".repeat(65_535)) }).pipe(
            Effect.either,
          ),
          sql`INSERT INTO kernel_workflow_instances (
            instance_id, workflow_type, workflow_version, workflow_key, payload_json,
            event_cursor, created_at
          ) VALUES (
            ${`${"é".repeat(128)}a`}, 'review', 1, 'key', 'null', 0,
            ${timestamp.toISOString()}
          )`.pipe(Effect.either),
          sql`INSERT INTO kernel_waits (
            instance_id, wait_id, event_type, event_version, event_key, correlation,
            after_sequence, state, registered_at
          ) VALUES (
            'instance-1', ${`${"é".repeat(128)}a`}, 'type', 1, 'key', 'correlation',
            0, 'pending', ${timestamp.toISOString()}
          )`.pipe(Effect.either),
        ])
        return results.map(({ _tag }) => _tag)
      }),
    )

    expect(tags).toEqual(Array.from({ length: 8 }, () => "Left"))
  })
})

import { expect, test } from "bun:test"
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

const timestamp = new Date("2026-08-11T12:00:00.000Z")
const instance = (instanceId: string) => ({
  instanceId,
  workflowType: "review",
  workflowVersion: 1,
  workflowKey: instanceId,
  payload: null,
  createdAt: timestamp,
})
const event = (sourceEventId: string, instanceId = "instance-a") => ({
  instanceId,
  dedupeKey: sourceEventId,
  source: "github",
  sourceEventId,
  event: {
    type: "approval",
    version: 1,
    key: "gate-7",
    correlation: "gate-7",
    payload: { approved: true },
  },
  recordedAt: timestamp,
})

const removeDatabase = async (filename: string) => {
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

const runOnFile = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, KernelEventStorePort | SqlClientService>,
) => {
  const database = SqliteClient.layer({ filename })
  return Effect.runPromise(
    effect.pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(database)))),
  )
}

const bootstrapFile = (filename: string) => {
  const database = SqliteClient.layer({ filename })
  return Effect.runPromise(
    Effect.void.pipe(Effect.provide(WorkflowStoreLive.pipe(Layer.provideMerge(database)))),
  )
}

test("independent connections replay one exact event without duplicate rows", async () => {
  const filename = `${process.cwd()}/kernel-concurrent-${crypto.randomUUID()}.sqlite`
  try {
    await bootstrapFile(filename)
    await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-a"))
        yield* store.registerWait({
          instanceId: "instance-a",
          waitId: "wait-a",
          condition: { type: "approval", version: 1, key: "gate-7", correlation: "gate-7" },
          registeredAt: timestamp,
        })
      }),
    )
    const results = await Promise.all([
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.recordEvent(event("same"))
        }).pipe(Effect.either),
      ),
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.recordEvent(event("same"))
        }).pipe(Effect.either),
      ),
    ])
    const rows = await runOnFile(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const events = yield* sql`SELECT sequence FROM kernel_events`
        const deliveries = yield* sql`SELECT event_sequence FROM kernel_wait_event_deliveries`
        return { events, deliveries }
      }),
    )

    expect(results.every((result) => result._tag === "Right")).toBe(true)
    expect(
      results.flatMap((result) => (result._tag === "Right" ? [result.right.status] : [])).sort(),
    ).toEqual(["duplicate", "recorded"])
    const successful = results.flatMap((result) => (result._tag === "Right" ? [result.right] : []))
    expect(successful.find(({ status }) => status === "recorded")?.deliveries).toHaveLength(1)
    expect(successful.find(({ status }) => status === "duplicate")?.deliveries).toEqual([])
    expect(rows.events).toHaveLength(1)
    expect(rows.deliveries).toHaveLength(1)
  } finally {
    await removeDatabase(filename)
  }
})

test("distinct concurrent events allocate different global sequences", async () => {
  const filename = `${process.cwd()}/kernel-sequence-${crypto.randomUUID()}.sqlite`
  try {
    await bootstrapFile(filename)
    await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-a"))
        yield* store.createInstance(instance("instance-b"))
      }),
    )
    const results = await Promise.all([
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.recordEvent(event("one", "instance-a"))
        }),
      ),
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.recordEvent(event("two", "instance-b"))
        }),
      ),
    ])

    expect(results.map(({ event }) => event.sequence).sort()).toEqual([1, 2])
  } finally {
    await removeDatabase(filename)
  }
})

test("a concurrent changed source replay returns a typed conflict", async () => {
  const filename = `${process.cwd()}/kernel-conflict-${crypto.randomUUID()}.sqlite`
  try {
    await bootstrapFile(filename)
    await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-a"))
      }),
    )
    const changed = {
      ...event("same"),
      event: { ...event("same").event, payload: { approved: false } },
    }
    const results = await Promise.all([
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.recordEvent(event("same"))
        }).pipe(Effect.either),
      ),
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.recordEvent(changed)
        }).pipe(Effect.either),
      ),
    ])

    const errors = results.flatMap((result) => (result._tag === "Left" ? [result.left] : []))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ _tag: "KernelStoreConflictError", record: "event" })
  } finally {
    await removeDatabase(filename)
  }
})

test("instance and wait replay are deterministic across independent connections", async () => {
  const filename = `${process.cwd()}/kernel-identities-${crypto.randomUUID()}.sqlite`
  try {
    await bootstrapFile(filename)
    const instances = await Promise.all([
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.createInstance(instance("shared-instance"))
        }),
      ),
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.createInstance(instance("shared-instance"))
        }),
      ),
    ])
    const register = () =>
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.registerWait({
            instanceId: "shared-instance",
            waitId: "shared-wait",
            condition: { type: "approval", version: 1, key: "gate-7", correlation: "gate-7" },
            registeredAt: timestamp,
          })
        }),
      )
    const waits = await Promise.all([register(), register()])

    expect(instances.map(({ status }) => status).sort()).toEqual(["created", "duplicate"])
    expect(waits.map(({ status }) => status).sort()).toEqual(["duplicate", "registered"])
  } finally {
    await removeDatabase(filename)
  }
})

test("the same external id from different sources records separate facts", async () => {
  const filename = `${process.cwd()}/kernel-sources-${crypto.randomUUID()}.sqlite`
  try {
    await bootstrapFile(filename)
    const sequences = await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const github = yield* store.recordEvent(event("same-external-id"))
        const webhook = yield* store.recordEvent({
          ...event("same-external-id"),
          source: "webhook",
        })
        return [github.event.sequence, webhook.event.sequence]
      }),
    )

    expect(sequences).toEqual([1, 2])
  } finally {
    await removeDatabase(filename)
  }
})

test("concurrent event and wait arrival produces one delivery", async () => {
  const filename = `${process.cwd()}/kernel-arrival-${crypto.randomUUID()}.sqlite`
  try {
    await bootstrapFile(filename)
    await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-a"))
      }),
    )
    await Promise.all([
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.recordEvent(event("arrival"))
        }),
      ),
      runOnFile(
        filename,
        Effect.gen(function* () {
          const store = yield* KernelEventStore
          return yield* store.registerWait({
            instanceId: "instance-a",
            waitId: "arrival-wait",
            condition: { type: "approval", version: 1, key: "gate-7", correlation: "gate-7" },
            registeredAt: timestamp,
          })
        }),
      ),
    ])
    const deliveries = await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        return yield* store.readReadyDeliveries("instance-a")
      }),
    )

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.event.sourceEventId).toBe("arrival")
  } finally {
    await removeDatabase(filename)
  }
})

test("wait registration begins with a write and survives a committed writer interleaving", async () => {
  const filename = `${process.cwd()}/kernel-write-first-${crypto.randomUUID()}.sqlite`
  const marker = `${filename}.locked`
  let writer: ReturnType<typeof Bun.spawn> | undefined
  try {
    await bootstrapFile(filename)
    await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("instance-a"))
      }),
    )
    writer = Bun.spawn(
      [
        "bun",
        "-e",
        `import { Database } from "bun:sqlite";
         const db = new Database(process.env.TEST_DB!);
         db.exec("PRAGMA foreign_keys = ON");
         db.exec("BEGIN IMMEDIATE");
         db.query(\`INSERT INTO kernel_events (
           sequence, source, source_event_id, event_type, event_version, event_key, correlation,
           payload_json, recorded_at
         ) VALUES (1, 'github', 'interleaved', 'approval', 1, 'gate-7', 'gate-7', '{}', ?)\`)
           .run(process.env.TEST_TIMESTAMP!);
         await Bun.write(process.env.TEST_MARKER!, "locked");
         await Bun.sleep(200);
         db.exec("COMMIT");
         db.close();`,
      ],
      {
        env: {
          ...process.env,
          TEST_DB: filename,
          TEST_MARKER: marker,
          TEST_TIMESTAMP: timestamp.toISOString(),
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt += 1) {
      await Bun.sleep(5)
    }
    expect(await Bun.file(marker).exists()).toBe(true)

    const result = await runOnFile(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        return yield* store.registerWait({
          instanceId: "instance-a",
          waitId: "interleaved-wait",
          condition: { type: "approval", version: 1, key: "gate-7", correlation: "gate-7" },
          registeredAt: timestamp,
        })
      }).pipe(Effect.either),
    )
    expect(await writer.exited).toBe(0)

    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.deliveries).toEqual([
        { instanceId: "instance-a", waitId: "interleaved-wait", eventSequence: 1 },
      ])
    }
  } finally {
    writer?.kill()
    await Bun.file(marker)
      .delete()
      .catch(() => undefined)
    await removeDatabase(filename)
  }
})

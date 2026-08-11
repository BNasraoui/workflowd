import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient"
import { Effect, Layer } from "effect"
import {
  KernelEventStore,
  KernelEventStoreLive,
  type KernelEventStorePort,
} from "../../src/kernel/event-store"
import { WorkflowStoreLive } from "../../src/store"

const timestamp = new Date("2026-08-11T13:00:00.000Z")
const instance = (instanceId: string) => ({
  instanceId,
  workflowType: "review",
  workflowVersion: 1,
  workflowKey: instanceId,
  payload: null,
  createdAt: timestamp,
})
const wait = (instanceId: string, waitId: string, correlation: string) => ({
  instanceId,
  waitId,
  condition: { type: "signal", version: 1, key: "signal-key", correlation },
  registeredAt: timestamp,
})
const event = (sourceEventId: string, correlation: string) => ({
  source: "test",
  sourceEventId,
  event: {
    type: "signal",
    version: 1,
    key: "signal-key",
    correlation,
    payload: { sourceEventId },
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

const bootstrap = (filename: string) => {
  const database = SqliteClient.layer({ filename })
  return Effect.runPromise(
    Effect.void.pipe(Effect.provide(WorkflowStoreLive.pipe(Layer.provideMerge(database)))),
  )
}

const runKernel = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, KernelEventStorePort | SqlClientService>,
) => {
  const database = SqliteClient.layer({ filename })
  return Effect.runPromise(
    effect.pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(database)))),
  )
}

test("pending waits, retained facts, replay, and ready reads survive restart", async () => {
  const filename = `${process.cwd()}/kernel-restart-${crypto.randomUUID()}.sqlite`
  try {
    await bootstrap(filename)
    await runKernel(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        yield* store.createInstance(instance("pending-instance"))
        yield* store.registerWait(wait("pending-instance", "pending-wait", "pending"))

        yield* store.createInstance(instance("retained-instance"))
        yield* store.recordEvent(event("retained-event", "retained"))

        yield* store.createInstance(instance("ready-instance"))
        yield* store.registerWait(wait("ready-instance", "ready-wait", "ready"))
        yield* store.recordEvent(event("ready-event", "ready"))
      }),
    )

    const result = await runKernel(
      filename,
      Effect.gen(function* () {
        const store = yield* KernelEventStore
        const pending = yield* store.recordEvent(event("pending-event", "pending"))
        const retained = yield* store.registerWait(
          wait("retained-instance", "retained-wait", "retained"),
        )
        const replay = yield* store.recordEvent(event("ready-event", "ready"))
        const ready = yield* store.readReadyDeliveries("ready-instance")
        return { pending, retained, replay, ready }
      }),
    )

    expect(result.pending.deliveries).toEqual([
      { instanceId: "pending-instance", waitId: "pending-wait", eventSequence: 3 },
    ])
    expect(result.retained.deliveries).toEqual([
      { instanceId: "retained-instance", waitId: "retained-wait", eventSequence: 1 },
    ])
    expect(result.replay.status).toBe("duplicate")
    expect(result.ready).toHaveLength(1)
    expect(result.ready[0]?.event.sourceEventId).toBe("ready-event")
  } finally {
    await removeDatabase(filename)
  }
})

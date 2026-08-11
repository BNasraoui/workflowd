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

const runKernel = <A, E>(effect: Effect.Effect<A, E, KernelEventStorePort | SqlClientService>) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  return Effect.runPromise(
    effect.pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap)))),
  )
}

const timestamp = new Date("2026-08-11T14:00:00.000Z")
const instance = {
  instanceId: "instance-1",
  workflowType: "review",
  workflowVersion: 1,
  workflowKey: "instance-1",
  payload: null,
  createdAt: timestamp,
}
const wait = (waitId: string) => ({
  instanceId: "instance-1",
  waitId,
  condition: { type: "signal", version: 1, key: "signal-key", correlation: "subject" },
  registeredAt: timestamp,
})
const event = (sourceEventId: string) => ({
  source: "test",
  sourceEventId,
  event: { type: "signal", version: 1, key: "signal-key", correlation: "subject", payload: null },
  recordedAt: timestamp,
})

test("the kernel port exposes narrow delivery consumption", async () => {
  const method = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      return typeof Reflect.get(store, "consumeDelivery")
    }),
  )

  expect(method).toBe("function")
})

test("consumption advances the cursor so a new wait skips the consumed event", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      const first = yield* store.recordEvent(event("event-1"))
      const consumed = yield* store.consumeDelivery({
        instanceId: "instance-1",
        waitId: "wait-a",
        eventSequence: first.event.sequence,
        expectedCursor: 0,
      })
      const readyAfterConsume = yield* store.readReadyDeliveries("instance-1")
      const secondWait = yield* store.registerWait(wait("wait-b"))
      const second = yield* store.recordEvent(event("event-2"))
      return { consumed, readyAfterConsume, secondWait, second }
    }),
  )

  expect(result.consumed).toEqual({ status: "consumed", eventCursor: 1 })
  expect(result.readyAfterConsume).toEqual([])
  expect(result.secondWait.wait.afterSequence).toBe(1)
  expect(result.secondWait.deliveries).toEqual([])
  expect(result.second.deliveries).toEqual([
    { instanceId: "instance-1", waitId: "wait-b", eventSequence: 2 },
  ])
})

test("an event committed after the cursor is recovered by a later wait", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      const first = yield* store.recordEvent(event("event-1"))
      yield* store.consumeDelivery({
        instanceId: "instance-1",
        waitId: "wait-a",
        eventSequence: first.event.sequence,
        expectedCursor: 0,
      })
      yield* store.recordEvent(event("event-2"))
      return yield* store.registerWait(wait("wait-b"))
    }),
  )

  expect(result.deliveries).toEqual([
    { instanceId: "instance-1", waitId: "wait-b", eventSequence: 2 },
  ])
})

test("stale consumption is rejected and exact consumption replay is duplicate", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      const recorded = yield* store.recordEvent(event("event-1"))
      const stale = yield* store
        .consumeDelivery({
          instanceId: "instance-1",
          waitId: "wait-a",
          eventSequence: recorded.event.sequence,
          expectedCursor: 99,
        })
        .pipe(Effect.either)
      const readyAfterStale = yield* store.readReadyDeliveries("instance-1")
      const consumed = yield* store.consumeDelivery({
        instanceId: "instance-1",
        waitId: "wait-a",
        eventSequence: recorded.event.sequence,
        expectedCursor: 0,
      })
      const duplicate = yield* store.consumeDelivery({
        instanceId: "instance-1",
        waitId: "wait-a",
        eventSequence: recorded.event.sequence,
        expectedCursor: 0,
      })
      return { stale, readyAfterStale, consumed, duplicate }
    }),
  )

  expect(result.stale._tag).toBe("Left")
  expect(result.readyAfterStale).toHaveLength(1)
  expect(result.consumed.status).toBe("consumed")
  expect(result.duplicate).toEqual({ status: "duplicate", eventCursor: 1 })
})

test("consume replay stays exact after later progress and rejects a changed guard", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      const first = yield* store.recordEvent(event("event-1"))
      yield* store.consumeDelivery({
        instanceId: "instance-1",
        waitId: "wait-a",
        eventSequence: first.event.sequence,
        expectedCursor: 0,
      })
      yield* store.registerWait(wait("wait-b"))
      const second = yield* store.recordEvent(event("event-2"))
      yield* store.consumeDelivery({
        instanceId: "instance-1",
        waitId: "wait-b",
        eventSequence: second.event.sequence,
        expectedCursor: 1,
      })
      const exact = yield* store
        .consumeDelivery({
          instanceId: "instance-1",
          waitId: "wait-a",
          eventSequence: first.event.sequence,
          expectedCursor: 0,
        })
        .pipe(Effect.either)
      const changedGuard = yield* store
        .consumeDelivery({
          instanceId: "instance-1",
          waitId: "wait-a",
          eventSequence: first.event.sequence,
          expectedCursor: 99,
        })
        .pipe(Effect.either)
      return { exact, changedGuard }
    }),
  )

  expect(result.exact._tag).toBe("Right")
  expect(result.changedGuard._tag).toBe("Left")
})

test("an instance permits only one pending or matched wait", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      const second = yield* store.registerWait(wait("wait-b")).pipe(Effect.either)
      return second
    }),
  )

  expect(result._tag).toBe("Left")
})

test("a matched wait also blocks another active wait", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      yield* store.recordEvent(event("event-1"))
      return yield* store.registerWait(wait("wait-b")).pipe(Effect.either)
    }),
  )

  expect(result._tag).toBe("Left")
})

test("replaying a matched wait returns its ready delivery", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      yield* store.recordEvent(event("event-1"))
      return yield* store.registerWait(wait("wait-a"))
    }),
  )

  expect(result.status).toBe("duplicate")
  expect(result.deliveries).toEqual([
    { instanceId: "instance-1", waitId: "wait-a", eventSequence: 1 },
  ])
})

test("replaying a consumed wait does not return its consumed delivery", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      const recorded = yield* store.recordEvent(event("event-1"))
      yield* store.consumeDelivery({
        instanceId: "instance-1",
        waitId: "wait-a",
        eventSequence: recorded.event.sequence,
        expectedCursor: 0,
      })
      const replay = yield* store.registerWait(wait("wait-a"))
      const ready = yield* store.readReadyDeliveries("instance-1")
      return { replay, ready }
    }),
  )

  expect(result.replay.status).toBe("duplicate")
  expect(result.replay.deliveries).toEqual([])
  expect(result.ready).toEqual([])
})

test("ready recovery fails closed when the wait is not matched", async () => {
  const result = await runKernel(
    Effect.gen(function* () {
      const store = yield* KernelEventStore
      const sql = yield* SqlClient.SqlClient
      yield* store.createInstance(instance)
      yield* store.registerWait(wait("wait-a"))
      yield* store.recordEvent(event("event-1"))
      yield* sql`UPDATE kernel_waits SET state = 'consumed'
        WHERE instance_id = 'instance-1' AND wait_id = 'wait-a'`
      return yield* store.readReadyDeliveries("instance-1").pipe(Effect.either)
    }),
  )

  expect(result._tag).toBe("Left")
  if (result._tag === "Left") {
    expect(result.left).toMatchObject({ _tag: "KernelStoreDataError", record: "delivery" })
  }
})

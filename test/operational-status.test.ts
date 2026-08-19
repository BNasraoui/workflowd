import { describe, expect, test } from "bun:test"
import { SqlError } from "@effect/sql/SqlError"
import { Effect, Layer, Logger } from "effect"
import { operationalStatus } from "../src/operational-status"
import { WorkflowStore, type WorkflowStorePort } from "../src/store/contracts"
import {
  consecutiveFailuresBeforeFailing,
  WorkerHealth,
  WorkerHealthLive,
} from "../src/worker-health"
import { workLanes } from "../src/work-signal"
import { makeStoreLayer } from "./store/harness"

const silent = Logger.replace(
  Logger.defaultLogger,
  Logger.make<unknown, void>(() => undefined),
)

// Readiness is answered from the durable store and the in-memory worker record
// alone. No GitHub service is provided anywhere in this file, so a readiness
// answer that needed one would not build.
const ReadyLayer = Layer.merge(makeStoreLayer(), WorkerHealthLive)

const runEveryLane = Effect.gen(function* () {
  const health = yield* WorkerHealth
  yield* Effect.forEach(workLanes, health.recordIteration, { discard: true })
})

describe("operational status", () => {
  test("is ready once every lane has completed an iteration and the store answers", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runEveryLane
        return yield* operationalStatus()
      }).pipe(Effect.provide(ReadyLayer)),
    )

    expect(status.status).toBe("ready")
    expect(status.store).toBe("ok")
    expect(status.workers.map((lane) => lane.lane)).toEqual([...workLanes])
    expect(status.terminalFailures?.queues.map((queue) => queue.failed)).toEqual([0, 0, 0, 0])
  })

  test("is not ready while a lane has never completed an iteration", async () => {
    const status = await Effect.runPromise(operationalStatus().pipe(Effect.provide(ReadyLayer)))

    expect(status.status).toBe("not_ready")
    expect(status.store).toBe("ok")
    expect(status.workers).toEqual(
      workLanes.map((lane) => ({
        lane,
        status: "starting",
        completedIterations: 0,
        consecutiveFailures: 0,
      })),
    )
  })

  test("is not ready once a lane keeps failing its iterations", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const health = yield* WorkerHealth
        yield* runEveryLane
        yield* Effect.forEach(
          Array.from({ length: consecutiveFailuresBeforeFailing }),
          () => health.recordFailure("job"),
          { discard: true },
        )
        return yield* operationalStatus()
      }).pipe(Effect.provide(ReadyLayer)),
    )

    expect(status.status).toBe("not_ready")
    expect(status.workers).toContainEqual({
      lane: "job",
      status: "failing",
      completedIterations: 1,
      consecutiveFailures: consecutiveFailuresBeforeFailing,
    })
    expect(status.workers.filter((lane) => lane.lane !== "job").map((lane) => lane.status)).toEqual(
      ["ok", "ok", "ok"],
    )
  })

  test("clears a lane's failure streak as soon as it completes an iteration", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const health = yield* WorkerHealth
        yield* runEveryLane
        yield* Effect.forEach(
          Array.from({ length: consecutiveFailuresBeforeFailing }),
          () => health.recordFailure("command"),
          { discard: true },
        )
        yield* health.recordIteration("command")
        return yield* operationalStatus()
      }).pipe(Effect.provide(ReadyLayer)),
    )

    expect(status.status).toBe("ready")
  })

  test("is not ready and reports no counts when the durable store cannot answer", async () => {
    const unavailable = Layer.effect(
      WorkflowStore,
      Effect.map(WorkflowStore, (live): WorkflowStorePort => ({
        ...live,
        summarizeTerminalFailures: () =>
          Effect.fail(new SqlError({ cause: new Error("database is locked") })),
      })),
    ).pipe(Layer.provide(makeStoreLayer()))

    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runEveryLane
        return yield* operationalStatus()
      }).pipe(Effect.provide(Layer.merge(unavailable, WorkerHealthLive)), Effect.provide(silent)),
    )

    expect(status.status).toBe("not_ready")
    expect(status.store).toBe("unavailable")
    expect(status.terminalFailures).toBeNull()
  })
})

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Fiber, Layer } from "effect"
import { KernelEventStore, KernelEventStoreLive } from "../../src/kernel/event-store"

const [filename, startedPath, resultPath] = Bun.argv.slice(2)
if (filename === undefined || startedPath === undefined || resultPath === undefined) {
  throw new Error("expected database, started, and result paths")
}

const database = SqliteClient.layer({ filename, disableWAL: true })
const registration = Effect.gen(function* () {
  const store = yield* KernelEventStore
  return yield* store.registerWait({
    instanceId: "instance-a",
    waitId: "interleaved-wait",
    condition: { type: "approval", version: 1, key: "gate-7", correlation: "gate-7" },
    registeredAt: new Date("2026-08-11T12:00:00.000Z"),
  })
}).pipe(Effect.provide(KernelEventStoreLive.pipe(Layer.provideMerge(database))))

const fiber = Effect.runFork(registration)
await Bun.write(startedPath, "started")
const result = await Effect.runPromise(Fiber.join(fiber).pipe(Effect.result))
await Bun.write(resultPath, JSON.stringify(result))

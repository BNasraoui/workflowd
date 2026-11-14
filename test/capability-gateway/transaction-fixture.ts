import { Effect, Deferred, Fiber } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { seedCapabilityRun } from "./fixture"
import { runLifetime } from "../../src/store/run-lifetime"

const transactionFixture = Effect.gen(function* () {
  const { sql, runs, leases } = yield* seedCapabilityRun(Date.now())
  const entered = yield* Deferred.make<void>()
  const proceed = yield* Deferred.make<void>()
  const writer =
    process.argv.at(-1) === "lease"
      ? leases.beginRelease("run")
      : runs.operatorRequired({
          runId: "run",
          diagnostic: "fixture",
          now: new Date(),
        })
  const outside = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(proceed)
        yield* writer
      }),
    )
    .pipe(Effect.forkScoped)
  yield* Deferred.await(entered)
  const concurrent = yield* writer.pipe(Effect.forkScoped)
  // Give the contender a turn to acquire the old fence and block on SQLite.
  yield* Effect.yieldNow
  yield* Deferred.succeed(proceed, undefined)
  yield* Fiber.join(outside)
  yield* Fiber.join(concurrent)
  const lifetime = runLifetime(sql)
  let notifications = 0
  const remove = lifetime.listen("run", () => {
    notifications++
  })
  const before = yield* runs.read("run")
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* runs.cancel({ runId: "run", now: new Date() })
        return yield* Effect.fail(new Error("fixture rollback"))
      }),
    )
    .pipe(Effect.result)
  const after = yield* runs.read("run")
  remove()
  if (after?.state !== before?.state || notifications !== 1)
    throw new Error("rollback custody changed")
  // Rollback may abort an in-flight operation conservatively, but never records
  // a cancellation or leaves the local admission domain permanently fenced.
  yield* lifetime.withPermit(sql`SELECT 1`)
}).pipe(
  Effect.provide(AgentRunStoreLive),
  Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
  Effect.scoped,
)

if (import.meta.main) await Effect.runPromise(transactionFixture)

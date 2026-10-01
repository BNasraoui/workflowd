import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { makeResidentStore } from "../../src/resident/store"
import { SqlClient } from "effect/unstable/sql"
import { runStoreMigrations, runStoreMigrationsThrough0024 } from "../../src/store/migrations"
test("durable inbox separates waiting turn completion from wake turn completion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeResidentStore
      yield* store.attach("run1", "thread1", "/work/a", null)
      yield* store.started("thread1", "turn1")
      yield* store.park("thread1")
      expect(yield* store.completed("thread1", "turn1")).toBe("waiting")
      yield* store.enqueue("event1", "thread1", "CI completed")
      yield* store.enqueue("event1", "thread1", "CI completed")
      expect(yield* store.pending()).toHaveLength(1)
      yield* store.sending("event1")
      expect((yield* store.pending())[0]?.state).toBe("sending")
      yield* store.delivered("event1")
      expect(yield* store.pending()).toHaveLength(0)
      yield* store.started("thread1", "turn2")
      expect(yield* store.completed("thread1", "turn1")).toBe("waiting")
      expect(yield* store.completed("thread1", "turn2")).toBe("finished")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))

test.each(["prepared", "sending"])("completion retains a thread with a %s inbox result", (state) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeResidentStore
      yield* store.attach("run1", "thread1", "/work/a", null)
      yield* store.started("thread1", "wake1")
      yield* store.enqueue("result2", "thread1", "second result")
      if (state === "sending") yield* store.sending("result2")
      expect(yield* store.completed("thread1", "wake1")).toBe("waiting")
      yield* store.delivered("result2")
      yield* store.started("thread1", "wake2")
      expect(yield* store.completed("thread1", "wake2")).toBe("finished")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ),
)

test("closure migration preserves historical resident states without inventing process termination proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrationsThrough0024
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO resident_threads (run_id,thread_id,directory,model,state) VALUES ('legacy','legacy-thread','/old',NULL,'finished')`
      yield* runStoreMigrations
      const store = yield* makeResidentStore
      expect(yield* store.readRun("legacy")).toMatchObject({
        run_id: "legacy",
        thread_id: "legacy-thread",
        state: "finished",
        closure_confirmed: 0,
      })
      expect(yield* store.readRun("missing")).toBeNull()
      yield* store.recordClosure("legacy-thread", true)
      expect((yield* store.read("legacy-thread"))?.closure_confirmed).toBe(1)
      yield* store.recordClosure("legacy-thread", false)
      expect((yield* store.read("legacy-thread"))?.closure_confirmed).toBe(0)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))

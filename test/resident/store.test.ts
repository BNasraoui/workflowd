import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { makeResidentStore } from "../../src/resident/store"
import { runStoreMigrations } from "../../src/store/migrations"
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

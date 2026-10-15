import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Queue } from "effect"
import { TestClock } from "effect/testing"
import { makeIdentityWork } from "../src/github/identity-work"

test("bounds active scans and waiting PRs, retaining only the newest target", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>()
      const release = yield* Deferred.make<void>()
      const submit = yield* makeIdentityWork(4, 2)
      const job = (key: string, version = key) => ({
        key,
        run: Queue.offer(started, version).pipe(Effect.andThen(Deferred.await(release))),
      })
      for (const key of ["a", "b", "c", "d"]) {
        expect(yield* submit(job(key))).toBe(true)
        expect(yield* Queue.take(started)).toBe(key)
      }
      expect(yield* submit(job("e", "old"))).toBe(true)
      expect(yield* submit(job("e", "new"))).toBe(true)
      expect(yield* submit(job("f"))).toBe(true)
      expect(yield* submit(job("overflow"))).toBe(false)
      yield* TestClock.adjust("1 millis")
      expect(yield* Queue.size(started)).toBe(0)
      yield* Deferred.succeed(release, undefined)
      expect([yield* Queue.take(started), yield* Queue.take(started)].sort()).toEqual(["f", "new"])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test("replacement interrupts and joins the prior scan before starting the latest", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cancelling = yield* Deferred.make<void>()
      const finishCleanup = yield* Deferred.make<void>()
      const results: string[] = []
      const submit = yield* makeIdentityWork(4, 2)
      yield* submit({
        key: "repo/7",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cancelling, undefined).pipe(
              Effect.andThen(Deferred.await(finishCleanup)),
            ),
          ),
        ),
      })
      yield* Deferred.await(started)
      yield* submit({
        key: "repo/7",
        run: Effect.sync(() => {
          results.push("superseded")
        }),
      })
      yield* Deferred.await(cancelling)
      const done = yield* Deferred.make<void>()
      yield* submit({
        key: "repo/7",
        run: Effect.sync(() => {
          results.push("latest")
        }).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid),
      })
      expect(results).toEqual([])
      yield* Deferred.succeed(finishCleanup, undefined)
      yield* Deferred.await(done)
      expect(results).toEqual(["latest"])
    }).pipe(Effect.scoped),
  )
})

test("scope closure interrupts active work without completing it", async () => {
  const started = Deferred.makeUnsafe<void>()
  let completed = false
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const submit = yield* makeIdentityWork()
      yield* submit({
        key: "repo/7",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.andThen(
            Effect.sync(() => {
              completed = true
            }),
          ),
        ),
      })
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )
  await Effect.runPromise(Deferred.await(started))
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(completed).toBe(false)
})

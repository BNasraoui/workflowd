import { expect, test } from "bun:test"
import { Effect, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { retryAvailability, withAvailabilityDeadline } from "../src/availability-validation"

test("availability stops at 15 attempts before the deadline", async () => {
  const unavailable = { operation: "read catalogs", retryable: true }
  let attempts = 0
  let completed = false
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const validation = yield* retryAvailability(
        Effect.gen(function* () {
          attempts += 1
          yield* Effect.sleep("1 milli")
          return yield* Effect.fail(unavailable)
        }),
        () => ({ operation: "deadline", retryable: false }),
      ).pipe(
        Effect.result,
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true
          }),
        ),
        Effect.forkChild,
      )
      // 15 reads plus 14 gaps finish at 28.015s, independently of the 30s deadline.
      yield* TestClock.adjust("29 seconds")
      expect(completed).toBe(true)
      expect(attempts).toBe(15)
      return yield* Fiber.join(validation)
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: unavailable })
})

test("successive validations share the deadline and interrupt a hung read", async () => {
  let interrupted = false
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const validation = yield* withAvailabilityDeadline(
        retryAvailability(Effect.sleep("7999 millis"), () => "first timeout").pipe(
          Effect.andThen(
            retryAvailability(
              Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true
                  }),
                ),
              ),
              (lastFailure, timeoutMs) => ({ lastFailure, timeoutMs }),
            ),
          ),
        ),
        8_000,
      ).pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust("8 seconds")
      return yield* Fiber.join(validation)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { lastFailure: undefined, timeoutMs: 1 },
  })
  expect(interrupted).toBe(true)
})

import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { makeIdentityRequest } from "../src/github/identity-request"

test("scan requests share a rolling hourly installation budget, leaving publication available", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const request = makeIdentityRequest()
      let calls = 0
      const run = async () => ++calls
      yield* Effect.all(
        Array.from({ length: 1000 }, () => request(run, 91)),
        {
          concurrency: "unbounded",
        },
      )
      const exhausted = yield* request(run, 91).pipe(Effect.flip)
      expect(exhausted.message).toBe("scan budget exhausted, retry later")
      expect(calls).toBe(1000)
      yield* request(run)
      yield* request(run, 92)
      yield* TestClock.adjust("59 minutes")
      expect((yield* request(run, 91).pipe(Effect.flip)).message).toBe(exhausted.message)
      yield* TestClock.adjust("1 minute")
      yield* request(run, 91)
      expect(calls).toBe(1003)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test("failed reads consume budget and capacity returns gradually in the rolling window", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const request = makeIdentityRequest()
      const failed = () =>
        request(async () => {
          throw new Error("unavailable")
        }, 91).pipe(Effect.ignore)
      for (let i = 0; i < 500; i++) yield* failed()
      yield* TestClock.adjust("30 minutes")
      for (let i = 0; i < 500; i++) yield* failed()
      yield* TestClock.adjust("30 minutes")
      let calls = 0
      for (let i = 0; i < 500; i++)
        yield* request(async () => {
          calls++
        }, 91)
      expect(
        (yield* request(async () => {
          calls++
        }, 91).pipe(Effect.flip)).message,
      ).toBe("scan budget exhausted, retry later")
      expect(calls).toBe(500)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test.each([
  { status: 429 },
  { status: 403, message: "You have exceeded a secondary rate limit" },
  {
    status: 403,
    response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" } },
  },
  { status: 429, response: { headers: { "retry-after": "60" } } },
  { status: 403, response: { headers: { "retry-after": "60" } } },
])("backs off all identity requests after GitHub exhaustion: %j", async (error) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const request = makeIdentityRequest()
      yield* request(async () => {
        throw Object.assign(new Error("rate limit exhausted"), error)
      }).pipe(Effect.ignore)
      let calls = 0
      const next = yield* request(async () => {
        calls++
        return 7
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust("59 seconds")
      expect(calls).toBe(0)
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(next)).toBe(7)
      expect(calls).toBe(1)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test.each([{ "retry-after": "120" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" }])(
  "honours GitHub deadlines longer than the minimum backoff: %j",
  async (headers) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const request = makeIdentityRequest()
        yield* request(async () => {
          throw Object.assign(new Error("rate limit exhausted"), {
            status: 403,
            response: { headers },
          })
        }).pipe(Effect.ignore)
        let called = false
        const next = yield* request(async () => {
          called = true
        }).pipe(Effect.forkChild)
        yield* TestClock.adjust("119 seconds")
        expect(called).toBe(false)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(next)
        expect(called).toBe(true)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },
)

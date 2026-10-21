import { expect, test } from "bun:test"
import { Clock, Effect, Logger } from "effect"
import { TestClock } from "effect/testing"
import { OpenCodeAutomationError } from "../src/opencode"
import { OpenCodeAvailabilityError } from "../src/opencode/adapter"
import { startReviewAvailability } from "../src/review-availability"
import { WorkSignalLive } from "../src/work-signal"

const missing = (name = "agent pr-reviewer") =>
  new OpenCodeAutomationError({
    operation: "validate OpenCode availability",
    cause: new OpenCodeAvailabilityError([name]),
    retryable: true,
  })

const run = (test: Effect.Effect<void, never, never>, logs: unknown[] = []) =>
  Effect.runPromise(
    test.pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))]))),
  )

// Each check completes in memory before TestClock advances; no network races.
test("background failures back off 2, 4, 8, 16, 30 seconds and stay capped", async () => {
  const times: number[] = []
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        yield* startReviewAvailability(
          Effect.gen(function* () {
            times.push(yield* Clock.currentTimeMillis)
            return yield* Effect.fail(missing())
          }),
        )
        yield* TestClock.adjust("90 seconds")
        expect(times).toEqual([0, 2000, 6000, 14000, 30000, 60000, 90000])
      }),
    ).pipe(Effect.provide(WorkSignalLive), Effect.provide(TestClock.layer())),
  )
})

test("missing selection is confirmed twice, names the selection, and recovers", async () => {
  let ready = false
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* startReviewAvailability(
          Effect.suspend(() => (ready ? Effect.void : Effect.fail(missing()))),
        )
        yield* TestClock.adjust(0)
        expect(yield* monitor.health).toMatchObject({
          status: "unavailable",
          missing: ["agent pr-reviewer"],
        })
        yield* TestClock.adjust("2 seconds")
        expect(yield* monitor.health).toMatchObject({
          status: "misconfigured",
          missing: ["agent pr-reviewer"],
        })
        ready = true
        yield* TestClock.adjust("4 seconds")
        expect(yield* monitor.health).toEqual({ status: "available" })
      }),
    ).pipe(Effect.provide(WorkSignalLive), Effect.provide(TestClock.layer())),
  )
})

test("different missing selections do not confirm a misconfiguration", async () => {
  let reads = 0
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* startReviewAvailability(
          Effect.suspend(() =>
            Effect.fail(missing(++reads === 1 ? "agent pr-reviewer" : "model openai/test")),
          ),
        )
        yield* TestClock.adjust("2 seconds")
        expect(yield* monitor.health).toMatchObject({
          status: "unavailable",
          missing: ["model openai/test"],
        })
        yield* TestClock.adjust("4 seconds")
        expect(yield* monitor.health).toMatchObject({
          status: "misconfigured",
          missing: ["model openai/test"],
        })
      }),
    ).pipe(Effect.provide(WorkSignalLive), Effect.provide(TestClock.layer())),
  )
})

test("periodic checks close an available gate again and recover", async () => {
  let ready = true
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* startReviewAvailability(
          Effect.suspend(() => (ready ? Effect.void : Effect.never)),
        )
        yield* TestClock.adjust(0)
        expect(yield* monitor.whenAvailable(Effect.succeed("claimed"))).toBe("claimed")
        ready = false
        yield* TestClock.adjust("40 seconds")
        expect(yield* monitor.health).toMatchObject({ status: "unreachable", reason: "timeout" })
        expect(yield* monitor.whenAvailable(Effect.succeed("claimed"))).toBe("idle")
        ready = true
        yield* TestClock.adjust("30 seconds")
        expect(yield* monitor.health).toEqual({ status: "available" })
      }),
    ).pipe(Effect.provide(WorkSignalLive), Effect.provide(TestClock.layer())),
  )
})

test("hung reads are interrupted and timeout warnings are capped", async () => {
  const logs: unknown[] = []
  let interrupted = 0
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* startReviewAvailability(
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++
              }),
            ),
          ),
        )
        yield* TestClock.adjust("10 seconds")
        expect(yield* monitor.health).toMatchObject({ status: "unreachable", reason: "timeout" })
        expect(interrupted).toBe(1)
        yield* TestClock.adjust("50 seconds")
        expect(interrupted).toBeGreaterThan(1)
        expect(logs.filter((entry) => JSON.stringify(entry).includes("timed out"))).toHaveLength(1)
      }),
    ).pipe(Effect.provide(WorkSignalLive), Effect.provide(TestClock.layer())),
    logs,
  )
})

test("a defect is logged and the background check recovers", async () => {
  let reads = 0
  const logs: unknown[] = []
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* startReviewAvailability(
          Effect.suspend(() => (++reads === 1 ? Effect.die("broken check") : Effect.void)),
        )
        yield* TestClock.adjust(0)
        expect(yield* monitor.health).toMatchObject({ status: "unreachable", reason: "defect" })
        yield* TestClock.adjust("2 seconds")
        expect(yield* monitor.health).toEqual({ status: "available" })
      }),
    ).pipe(Effect.provide(WorkSignalLive), Effect.provide(TestClock.layer())),
    logs,
  )
  expect(JSON.stringify(logs)).toContain("defect")
})

test("background diagnostics omit nested causes and credential-bearing URLs", async () => {
  const logs: unknown[] = []
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        yield* startReviewAvailability(
          Effect.fail(
            new OpenCodeAutomationError({
              operation: "validate OpenCode availability",
              cause: new Error("https://user:secret@example.test/?token=private"),
              retryable: true,
            }),
          ),
        )
        yield* TestClock.adjust("60 seconds")
      }),
    ).pipe(Effect.provide(WorkSignalLive), Effect.provide(TestClock.layer())),
    logs,
  )
  expect(JSON.stringify(logs)).not.toContain("secret")
  expect(JSON.stringify(logs)).not.toContain("private")
  expect(logs.length).toBeLessThanOrEqual(2)
})

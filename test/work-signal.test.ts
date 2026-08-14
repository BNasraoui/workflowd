import { describe, expect, test } from "bun:test"
import { Effect, Option, Queue } from "effect"
import { WorkSignal, WorkSignalLive } from "../src/work-signal"

describe("WorkSignal", () => {
  test("retains a wake published after subscription but before waiting", async () => {
    const woke = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signals = yield* WorkSignal
          const subscription = yield* signals.subscribe("job")
          yield* signals.wake("job")
          yield* Queue.take(subscription)
          return true
        }).pipe(Effect.provide(WorkSignalLive)),
      ),
    )

    expect(woke).toBe(true)
  })

  test("coalesces a burst to one pending wake per subscriber", async () => {
    const pending = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signals = yield* WorkSignal
          const subscription = yield* signals.subscribe("job")
          yield* signals.wake("job")
          yield* signals.wake("job")
          yield* signals.wake("job")
          yield* Queue.take(subscription)
          return yield* Queue.poll(subscription)
        }).pipe(Effect.provide(WorkSignalLive)),
      ),
    )

    expect(Option.isNone(pending)).toBe(true)
  })

  test("fans a same-lane wake out to every subscriber", async () => {
    const sizes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signals = yield* WorkSignal
          const first = yield* signals.subscribe("job")
          const second = yield* signals.subscribe("job")
          yield* signals.wake("job")
          return [yield* Queue.size(first), yield* Queue.size(second)]
        }).pipe(Effect.provide(WorkSignalLive)),
      ),
    )

    expect(sizes).toEqual([1, 1])
  })

  test("keeps kernel job wakes on a separate lane", async () => {
    const pending = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signals = yield* WorkSignal
          const kernelJobs = yield* signals.subscribe("kernel-job")
          const legacyJobs = yield* signals.subscribe("job")
          yield* signals.wake("kernel-job")
          return {
            kernelJob: yield* Queue.poll(kernelJobs),
            legacyJob: yield* Queue.poll(legacyJobs),
          }
        }).pipe(Effect.provide(WorkSignalLive)),
      ),
    )

    expect(Option.isSome(pending.kernelJob)).toBe(true)
    expect(Option.isNone(pending.legacyJob)).toBe(true)
  })

  test("keeps local resume wakes on a separate coalescing lane", async () => {
    const pending = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signals = yield* WorkSignal
          const resumes = yield* signals.subscribe("session-resume")
          const jobs = yield* signals.subscribe("kernel-job")
          yield* signals.wake("session-resume")
          yield* signals.wake("session-resume")
          return {
            resume: yield* Queue.size(resumes),
            job: yield* Queue.poll(jobs),
          }
        }).pipe(Effect.provide(WorkSignalLive)),
      ),
    )

    expect(pending.resume).toBe(1)
    expect(Option.isNone(pending.job)).toBe(true)
  })
})

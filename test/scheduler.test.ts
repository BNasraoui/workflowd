import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { Scheduler, SchedulerLive } from "../src/scheduler"

describe("Scheduler", () => {
  test("coalesces a burst into one pending wake per subscriber", async () => {
    const pending = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const subscription = yield* scheduler.subscribe("job")

          yield* Effect.all([
            scheduler.signal("job"),
            scheduler.signal("job"),
            scheduler.signal("job"),
          ])
          yield* subscription.wait
          const second = yield* Effect.fork(subscription.wait)
          yield* Effect.sleep(10)
          const status = yield* Fiber.status(second)
          yield* Fiber.interrupt(second)
          return status._tag
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(pending).toBe("Suspended")
  })

  test("broadcasts a lane wake to every same-lane subscriber", async () => {
    const wakes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const first = yield* scheduler.subscribe("job")
          const second = yield* scheduler.subscribe("job")

          yield* scheduler.signal("job")
          return yield* Effect.all([first.wait, second.wait]).pipe(
            Effect.timeoutOption("100 millis"),
          )
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(wakes._tag).toBe("Some")
  })

  test("interrupts a pending wait when its subscription scope closes", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const subscriptionScope = yield* Scope.make()
          const subscription = yield* Scope.extend(
            scheduler.subscribe("reconciliation"),
            subscriptionScope,
          )
          const waiting = yield* Effect.fork(subscription.wait)

          yield* Scope.close(subscriptionScope, Exit.void)
          return yield* Fiber.await(waiting)
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(Exit.isInterrupted(exit)).toBe(true)
  })
})

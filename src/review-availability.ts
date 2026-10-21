import { Effect, Ref } from "effect"
import type { OpenCodeAutomationError } from "./opencode"
import { WorkSignal } from "./work-signal"

export type ReviewAvailability = {
  readonly status: "unavailable" | "misconfigured" | "available" | "disabled"
}

/** Startup readiness owns no job leases; failed checks cannot tear down the daemon. */
export const startReviewAvailability = (
  check: Effect.Effect<void, OpenCodeAutomationError> | undefined,
) =>
  Effect.gen(function* () {
    const signals = yield* WorkSignal
    const state = yield* Ref.make<ReviewAvailability>({
      status: check === undefined ? "disabled" : "unavailable",
    })
    if (check !== undefined) {
      yield* Effect.gen(function* () {
        let previous: ReviewAvailability["status"] | undefined
        let delayMs = 2_000
        while (true) {
          const result = yield* check.pipe(Effect.result, Effect.timeoutOption("10 seconds"))
          const status: ReviewAvailability["status"] =
            result._tag === "None"
              ? "unavailable"
              : result.value._tag === "Success"
                ? "available"
                : result.value.failure.retryable
                  ? "unavailable"
                  : "misconfigured"
          yield* Ref.set(state, { status })
          if (status !== previous) {
            yield* status === "misconfigured"
              ? Effect.logError("Review automation misconfigured; required agent or model missing")
              : status === "available"
                ? Effect.logInfo("Review automation available")
                : Effect.logWarning("Review automation unavailable; checking in background")
            previous = status
          }
          if (status === "available") {
            yield* signals.wake("job")
            return
          }
          yield* Effect.sleep(delayMs)
          delayMs = Math.min(delayMs * 2, 30_000)
        }
      }).pipe(Effect.forkScoped)
    }
    return {
      health: Ref.get(state),
      whenAvailable: <A extends string, E, R>(iteration: Effect.Effect<A, E, R>) =>
        Ref.get(state).pipe(
          Effect.flatMap(({ status }): Effect.Effect<A | "idle", E, R> =>
            status === "available" ? iteration : Effect.succeed("idle" as const),
          ),
        ),
    }
  })

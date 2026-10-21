import { Cause, Clock, Duration, Effect, Logger, Ref, Schedule } from "effect"
import type { OpenCodeAutomationError } from "./opencode"
import { OpenCodeAvailabilityError } from "./opencode/adapter"
import { WorkSignal } from "./work-signal"

export type ReviewAvailability = {
  readonly status: "unavailable" | "unreachable" | "misconfigured" | "available" | "disabled"
  readonly reason?: "timeout" | "defect" | "check_failed" | "missing_selection"
  readonly missing?: ReadonlyArray<string>
}

/** Checks own no job leases and keep running after recovery. */
export const startReviewAvailability = (
  check: Effect.Effect<void, OpenCodeAutomationError> | undefined,
  lane: "review" | "fix" = "review",
) =>
  Effect.gen(function* () {
    const signals = yield* WorkSignal
    const state = yield* Ref.make<ReviewAvailability>({
      status: check === undefined ? "disabled" : "unavailable",
    })
    if (check !== undefined) {
      let previousMissing: string | undefined
      let lastLog = ""
      let lastLogAt = -Infinity
      const observe = Effect.gen(function* () {
        // Shared adapter callers retain every diagnostic. This loop owns its log cap.
        const result = yield* check.pipe(
          Effect.provide(Logger.layer([])),
          Effect.result,
          Effect.timeoutOption("10 seconds"),
        )
        if (result._tag === "None") return { status: "unreachable", reason: "timeout" } as const
        if (result.value._tag === "Success") return { status: "available" } as const
        const failure = result.value.failure.cause
        if (failure instanceof OpenCodeAvailabilityError) {
          const signature = JSON.stringify(failure.unavailable)
          const status = signature === previousMissing ? "misconfigured" : "unavailable"
          previousMissing = signature
          return { status, reason: "missing_selection", missing: failure.unavailable } as const
        }
        return { status: "unavailable", reason: "check_failed" } as const
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.succeed({ status: "unreachable", reason: "defect" } as const),
        ),
      )
      yield* Effect.gen(function* () {
        const next: ReviewAvailability = yield* observe
        if (next.reason !== "missing_selection") previousMissing = undefined
        const previous = yield* Ref.getAndSet(state, next)
        const now = yield* Clock.currentTimeMillis
        const signature = JSON.stringify(next)
        if (signature !== lastLog || now - lastLogAt >= 60_000) {
          const details = { lane, ...next }
          yield* next.reason === "timeout"
            ? Effect.logWarning(
                "Review automation check timed out; hung reviewer needs an operator restart",
                details,
              )
            : next.reason === "defect"
              ? Effect.logError(
                  "Review automation check defect; checking again in background",
                  details,
                )
              : next.status === "misconfigured"
                ? Effect.logError("Review automation misconfigured", details)
                : next.status === "available"
                  ? Effect.logInfo("Review automation available", details)
                  : Effect.logWarning(
                      "Review automation unavailable; checking in background",
                      details,
                    )
          lastLog = signature
          lastLogAt = now
        }
        if (next.status === "available" && previous.status !== "available")
          yield* signals.wake("job")
        return next
      }).pipe(
        Effect.repeat(
          Schedule.exponential("2 seconds").pipe(
            Schedule.setInputType<ReviewAvailability>(),
            Schedule.modifyDelay(({ input, duration }) =>
              Effect.succeed(
                input.status === "available"
                  ? 30_000
                  : Duration.min(duration, Duration.seconds(30)),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      )
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

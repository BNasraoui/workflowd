import { Clock, Context, Effect, Schedule } from "effect"

const AvailabilityDeadline = Context.Reference("workflowd/AvailabilityDeadline", {
  defaultValue: (): number | undefined => undefined,
})

/** All availability checks within this effect share one deadline, including preflight. */
export const withAvailabilityDeadline = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  budgetMs: number,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* effect.pipe(Effect.provideService(AvailabilityDeadline, now + budgetMs))
  })

/** Catalog reads can race location activation, including after idle eviction. */
export const retryAvailability = <
  A,
  E extends { readonly retryable: boolean; readonly operation: string },
  R,
  E2,
>(
  check: Effect.Effect<A, E, R>,
  onTimeout: (lastFailure: E | undefined, timeoutMs: number) => E2,
) =>
  Effect.gen(function* () {
    const deadline = yield* AvailabilityDeadline
    const now = yield* Clock.currentTimeMillis
    const timeoutMs =
      deadline === undefined ? 30_000 : Math.max(0, Math.min(30_000, deadline - now))
    let lastFailure: E | undefined
    return yield* check.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          lastFailure = error
        }),
      ),
      Effect.retry({
        while: (error) => error.retryable,
        schedule: Schedule.spaced("2 seconds").pipe(
          Schedule.upTo({ times: 14 }),
          Schedule.setInputType<E>(),
          Schedule.tap(({ input }) =>
            Effect.logWarning("OpenCode availability check failed; retrying", {
              operation: input.operation,
            }),
          ),
        ),
      }),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(onTimeout(lastFailure, timeoutMs)),
      }),
    )
  })

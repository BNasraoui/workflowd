import { Effect, Schedule } from "effect"

/** Catalog reads can race location activation, including after idle eviction. */
export const retryAvailability = <
  A,
  E extends { readonly retryable: boolean; readonly operation: string },
  R,
  E2,
>(
  check: Effect.Effect<A, E, R>,
  onTimeout: (lastFailure: E | undefined) => E2,
) =>
  Effect.suspend(() => {
    let lastFailure: E | undefined
    return check.pipe(
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
        duration: "30 seconds",
        orElse: () => Effect.fail(onTimeout(lastFailure)),
      }),
    )
  })

import { Effect, Schedule } from "effect"
import type { OpenCodeAutomationError } from "./opencode"

/** Catalog reads can temporarily omit configured integrations even on a running server. */
export const validateOpenCodeStartup = (check: Effect.Effect<void, OpenCodeAutomationError>) =>
  Effect.suspend(() => {
    let lastFailure: OpenCodeAutomationError | undefined
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
          Schedule.setInputType<OpenCodeAutomationError>(),
          Schedule.tap(({ input }) =>
            Effect.logWarning("OpenCode startup availability check failed; retrying", input),
          ),
        ),
      }),
      Effect.mapError(
        (error) =>
          new Error(
            `OpenCode startup validation failed (${error.operation}): ${String(error.cause)}`,
            { cause: error },
          ),
      ),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new Error(
              `OpenCode startup validation timed out after 30 seconds${lastFailure === undefined ? "" : ` (${lastFailure.operation}): ${String(lastFailure.cause)}`}`,
              { cause: lastFailure },
            ),
          ),
      }),
    )
  })

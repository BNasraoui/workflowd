import { Effect } from "effect"
import { OpenCodeAutomationError } from "./opencode"
import { retryAvailability } from "./availability-validation"

/** Location plugin activation can outlive the first catalog reads, even on a running server. */
export const validateOpenCodeStartup = (check: Effect.Effect<void, OpenCodeAutomationError>) =>
  retryAvailability(
    check,
    (lastFailure) =>
      new Error(
        `OpenCode startup validation timed out after 30 seconds${lastFailure === undefined ? "" : ` (${lastFailure.operation}): ${String(lastFailure.cause)}`}`,
        { cause: lastFailure },
      ),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof OpenCodeAutomationError
        ? new Error(
            `OpenCode startup validation failed (${error.operation}): ${String(error.cause)}`,
            { cause: error },
          )
        : error,
    ),
  )

import { Effect, FiberSet } from "effect"
import type { GitHubPort } from "../github"

// Own scans in the daemon scope, independently of the HTTP request scope.
// Deliveries are already stored when the webhook handler calls this dispatcher.
export const makeIdentityCheckDispatcher = Effect.fn("GitIdentity.dispatcher")(function* (
  github: GitHubPort | undefined,
) {
  const check = github?.checkAgentGitIdentity
  if (check === undefined) return undefined
  const pending = yield* FiberSet.make<void>()
  return (event: string, payload: unknown) =>
    FiberSet.run(
      pending,
      check(event, payload).pipe(
        Effect.catch(() => Effect.logError("Git identity check unavailable")),
      ),
    ).pipe(Effect.asVoid)
})

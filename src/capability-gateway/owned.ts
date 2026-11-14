import { Effect } from "effect"

/** For bounded abort-aware adapters: interruption aborts AND joins their cleanup. */
export const ownedPromise = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
  Effect.callback<A, Error>((resume, signal) => {
    const pending = operation(signal)
    void pending.then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) =>
        resume(
          Effect.fail(error instanceof Error ? error : new Error("capability adapter unavailable")),
        ),
    )
    return Effect.promise(() =>
      pending.then(
        () => undefined,
        () => undefined,
      ),
    )
  })

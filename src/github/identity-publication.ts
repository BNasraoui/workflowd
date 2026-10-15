import { Effect } from "effect"
import type { IdentityRequest } from "./identity-request"

type Lease = { readonly controller: AbortController; pendingWrite: Effect.Effect<void> }

// Cancellation does not revoke a write already sent to GitHub. Drain it before
// a replacement can reset this check ID, even if a client ignores AbortSignal.
export const makeIdentityPublication = () => {
  const owners = new Map<string, Lease>()
  return Effect.fn("GitIdentity.publication")(function* (key: string, request: IdentityRequest) {
    const previous = owners.get(key)
    previous?.controller.abort()
    const lease: Lease = {
      controller: new AbortController(),
      pendingWrite: previous?.pendingWrite ?? Effect.void,
    }
    owners.set(key, lease)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        lease.controller.abort()
        yield* lease.pendingWrite
        if (owners.get(key) === lease) owners.delete(key)
      }),
    )
    yield* lease.pendingWrite
    return <A>(run: (signal: AbortSignal) => Promise<A>) =>
      Effect.gen(function* () {
        if (lease.controller.signal.aborted) return yield* Effect.interrupt
        return yield* request((signal) => {
          lease.controller.signal.throwIfAborted()
          const pending = run(AbortSignal.any([signal, lease.controller.signal]))
          lease.pendingWrite = Effect.promise(() =>
            pending.then(
              () => {},
              () => {},
            ),
          )
          return pending
        })
      })
  })
}
export type IdentityPublication = ReturnType<typeof makeIdentityPublication>

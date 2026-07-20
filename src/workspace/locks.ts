import { Deferred, Effect, type Scope } from "effect"

type LockEntry = {
  readonly semaphore: Effect.Semaphore
  references: number
}

export class ScopedKeyedLock {
  readonly #entries = new Map<string, LockEntry>()

  acquire(key: string): Effect.Effect<void, never, Scope.Scope> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        let entry = this.#entries.get(key)
        if (entry === undefined) {
          entry = {
            semaphore: Effect.unsafeMakeSemaphore(1),
            references: 0,
          }
          this.#entries.set(key, entry)
        }
        entry.references += 1
        const acquired = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            entry.references -= 1
            if (entry.references === 0 && this.#entries.get(key) === entry) {
              this.#entries.delete(key)
            }
          }),
        )
        yield* restore(
          entry.semaphore.withPermits(1)(
            Deferred.succeed(acquired, undefined).pipe(
              Effect.zipRight(Deferred.await(released)),
            ),
          ).pipe(Effect.forkScoped),
        )
        yield* restore(Deferred.await(acquired))
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(released, undefined).pipe(Effect.asVoid),
        )
      }),
    )
  }
}

import { Clock, Effect, Fiber, Queue, Schedule } from "effect"

import { IdentityBudgetExhausted } from "./identity-request"

export type IdentityWork = {
  readonly key: string
  readonly prKey?: string
  readonly trusted?: boolean
  readonly preserve?: () => boolean
  readonly supersede?: () => void
  readonly run: Effect.Effect<void, Error>
}

type Entry = {
  retryAt: number | undefined
  supersede: (() => void) | undefined
  interrupted: boolean
  next: IdentityWork | undefined
  fiber: Fiber.Fiber<void, Error> | undefined
}

// One entry per key, including work whose interruption finalizers are still running.
// Replacements never start until the previous fiber has actually exited.
export const makeIdentityWork = Effect.fn("GitIdentity.work")(function* (
  concurrency = 4,
  waiting = 100,
  trustedReserve = 0,
) {
  const ready = yield* Queue.unbounded<Entry>()
  const entries = new Map<string, Entry>()
  const worker = Effect.gen(function* () {
    const entry = yield* Queue.take(ready)
    if (entry.next === undefined) return
    const job = entry.next
    entry.next = undefined
    entry.supersede = job.supersede
    entry.fiber = yield* Effect.forkChild(
      job.run.pipe(
        Effect.catchIf(
          (error) => error instanceof IdentityBudgetExhausted,
          (error) =>
            Effect.sync(() => {
              if (entry.next === undefined) {
                entry.next = job
                entry.retryAt = error.retryAt
              }
            }),
        ),
      ),
      { startImmediately: false },
    )
    yield* Fiber.await(entry.fiber)
    entry.fiber = undefined
    entry.supersede = undefined
    if (entry.retryAt !== undefined) return
    if (entry.next !== undefined) yield* Queue.offer(ready, entry)
    else entries.delete(job.key)
  })
  // Delayed jobs retain their bounded slot, but do not occupy scan workers.
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    for (const entry of entries.values()) {
      if (entry.retryAt !== undefined && entry.retryAt <= now) {
        entry.retryAt = undefined
        yield* Queue.offer(ready, entry)
      }
    }
  }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped)
  for (let i = 0; i < concurrency; i++) yield* worker.pipe(Effect.forever, Effect.forkScoped)
  return Effect.fn("GitIdentity.submit")(function* (job: IdentityWork, replace = true) {
    const entry = entries.get(job.key)
    if (entry !== undefined) {
      if (!replace) return true
      // Keep the check ID owned by a deferred completion on same-head redelivery.
      if (entry.retryAt !== undefined && entry.next?.preserve?.()) return true
      entry.next = job
      if (entry.fiber !== undefined) {
        entry.interrupted = true
        entry.supersede?.()
        entry.fiber.interruptUnsafe()
      }
      return true
    }
    if (job.prKey !== undefined) {
      const pending = [...entries].filter(
        ([, entry]) => entry.fiber === undefined && entry.next?.prKey === job.prKey,
      )
      if (pending.length >= 2) {
        if (!replace) return false
        // Never discard a check that is already open, including one owned by
        // the interrupted predecessor of a same-head pull_request delivery.
        const oldest = pending.find(([, entry]) => !entry.interrupted && !entry.next?.preserve?.())
        if (oldest === undefined) return false
        // Reuse the queued slot: leaving tombstone keys in ready would make
        // memory grow without bound during a stalled worker's push flood.
        entries.delete(oldest[0])
        oldest[1].next = job
        entries.set(job.key, oldest[1])
        return true
      }
    }
    const limit = concurrency + waiting - (job.trusted ? 0 : trustedReserve)
    if (entries.size >= limit) {
      // Deferred starts own no visible check and are recoverable on restart.
      // Map order retains admission age; never evict running work or a check ID.
      const oldest = [...entries].find(
        ([, entry]) =>
          entry.retryAt !== undefined && entry.fiber === undefined && !entry.next?.preserve?.(),
      )
      if (oldest === undefined) return false
      entries.delete(oldest[0])
    }
    const added: Entry = {
      retryAt: undefined,
      next: job,
      fiber: undefined,
      interrupted: false,
      supersede: undefined,
    }
    entries.set(job.key, added)
    yield* Queue.offer(ready, added)
    return true
  })
})

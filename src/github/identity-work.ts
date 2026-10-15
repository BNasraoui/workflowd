import { Effect, Fiber, Queue } from "effect"

export type IdentityWork = {
  readonly key: string
  readonly prKey?: string
  readonly preserve?: boolean
  readonly run: Effect.Effect<void, Error>
}

type Entry = {
  interrupted: boolean
  next: IdentityWork | undefined
  fiber: Fiber.Fiber<void, Error> | undefined
}

// One entry per key, including work whose interruption finalizers are still running.
// Replacements never start until the previous fiber has actually exited.
export const makeIdentityWork = Effect.fn("GitIdentity.work")(function* (
  concurrency = 4,
  waiting = 100,
) {
  const ready = yield* Queue.unbounded<Entry>()
  const entries = new Map<string, Entry>()
  const worker = Effect.gen(function* () {
    const entry = yield* Queue.take(ready)
    if (entry.next === undefined) return
    const job = entry.next
    entry.next = undefined
    entry.fiber = yield* Effect.forkChild(job.run, { startImmediately: false })
    yield* Fiber.await(entry.fiber)
    entry.fiber = undefined
    if (entry.next !== undefined) yield* Queue.offer(ready, entry)
    else entries.delete(job.key)
  })
  for (let i = 0; i < concurrency; i++) yield* worker.pipe(Effect.forever, Effect.forkScoped)
  return Effect.fn("GitIdentity.submit")(function* (job: IdentityWork, replace = true) {
    const entry = entries.get(job.key)
    if (entry !== undefined) {
      if (!replace) return true
      entry.next = job
      if (entry.fiber !== undefined) {
        entry.interrupted = true
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
        const oldest = pending.find(([, entry]) => !entry.interrupted && !entry.next?.preserve)
        if (oldest === undefined) return false
        // Reuse the queued slot: leaving tombstone keys in ready would make
        // memory grow without bound during a stalled worker's push flood.
        entries.delete(oldest[0])
        oldest[1].next = job
        entries.set(job.key, oldest[1])
        return true
      }
    }
    if (entries.size >= concurrency + waiting) return false
    const added = { next: job, fiber: undefined, interrupted: false }
    entries.set(job.key, added)
    yield* Queue.offer(ready, added)
    return true
  })
})

import { Effect, Fiber, Queue } from "effect"

export type IdentityWork = { readonly key: string; readonly run: Effect.Effect<void, Error> }

// One entry per key, including work whose interruption finalizers are still running.
// Replacements never start until the previous fiber has actually exited.
export const makeIdentityWork = Effect.fn("GitIdentity.work")(function* (
  concurrency = 4,
  waiting = 100,
) {
  const ready = yield* Queue.unbounded<string>()
  const entries = new Map<
    string,
    {
      next: IdentityWork | undefined
      fiber: Fiber.Fiber<void, Error> | undefined
    }
  >()
  const worker = Effect.gen(function* () {
    const key = yield* Queue.take(ready)
    const entry = entries.get(key)
    if (entry?.next === undefined) return
    const job = entry.next
    entry.next = undefined
    entry.fiber = yield* Effect.forkChild(job.run, { startImmediately: false })
    yield* Fiber.await(entry.fiber)
    entry.fiber = undefined
    if (entry.next !== undefined) yield* Queue.offer(ready, key)
    else entries.delete(key)
  })
  for (let i = 0; i < concurrency; i++) yield* worker.pipe(Effect.forever, Effect.forkScoped)
  return Effect.fn("GitIdentity.submit")(function* (job: IdentityWork, replace = true) {
    const entry = entries.get(job.key)
    if (entry !== undefined) {
      if (!replace) return true
      entry.next = job
      if (entry.fiber !== undefined) entry.fiber.interruptUnsafe()
      return true
    }
    if (entries.size >= concurrency + waiting) return false
    entries.set(job.key, { next: job, fiber: undefined })
    yield* Queue.offer(ready, job.key)
    return true
  })
})

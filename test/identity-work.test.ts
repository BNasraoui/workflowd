import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Queue } from "effect"
import { TestClock } from "effect/testing"
import { makeIdentityWork } from "../src/github/identity-work"
import { fixture, payload } from "./helpers/identity"

test("a PR retains only its two newest waiting heads without evicting active work or another PR", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>()
      const release = yield* Deferred.make<void>()
      const submit = yield* makeIdentityWork(1, 3)
      const f = fixture()
      const job = (version: number, number = 7) =>
        Effect.gen(function* () {
          const jobs = yield* f.app.identityCheckJobs("pull_request", {
            ...payload(),
            pull_request: { number, head: { sha: version.toString(16).padStart(40, "0") } },
          })
          const target = jobs[0]
          if (target === undefined) throw new Error("missing identity job")
          return {
            ...target,
            run: Queue.offer(started, String(version)).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          }
        })
      yield* submit(yield* job(5000))
      expect(yield* Queue.take(started)).toBe("5000")
      for (let i = 0; i < 5000; i++) expect(yield* submit(yield* job(i))).toBe(true)
      expect(yield* submit(yield* job(5001, 8))).toBe(true)
      // Recovery waits rather than replacing any admitted head.
      expect(yield* submit(yield* job(5002), false)).toBe(false)
      yield* Deferred.succeed(release, undefined)
      const ran = [
        yield* Queue.take(started),
        yield* Queue.take(started),
        yield* Queue.take(started),
      ]
      expect(ran.sort()).toEqual(["4998", "4999", "5001"])
    }).pipe(Effect.scoped),
  )
})

test("bounds active scans and waiting PRs, retaining only the newest target", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>()
      const release = yield* Deferred.make<void>()
      const submit = yield* makeIdentityWork(4, 2)
      const job = (key: string, version = key) => ({
        key,
        run: Queue.offer(started, version).pipe(Effect.andThen(Deferred.await(release))),
      })
      for (const key of ["a", "b", "c", "d"]) {
        expect(yield* submit(job(key))).toBe(true)
        expect(yield* Queue.take(started)).toBe(key)
      }
      expect(yield* submit(job("e", "old"))).toBe(true)
      expect(yield* submit(job("e", "new"))).toBe(true)
      expect(yield* submit(job("f"))).toBe(true)
      expect(yield* submit(job("overflow"))).toBe(false)
      yield* TestClock.adjust("1 millis")
      expect(yield* Queue.size(started)).toBe(0)
      yield* Deferred.succeed(release, undefined)
      expect([yield* Queue.take(started), yield* Queue.take(started)].sort()).toEqual(["f", "new"])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test("replacement interrupts and joins the prior scan before starting the latest", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cancelling = yield* Deferred.make<void>()
      const finishCleanup = yield* Deferred.make<void>()
      const results: string[] = []
      const submit = yield* makeIdentityWork(4, 2)
      yield* submit({
        key: "repo/7",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cancelling, undefined).pipe(
              Effect.andThen(Deferred.await(finishCleanup)),
            ),
          ),
        ),
      })
      yield* Deferred.await(started)
      yield* submit({
        key: "repo/7",
        run: Effect.sync(() => {
          results.push("superseded")
        }),
      })
      yield* Deferred.await(cancelling)
      const done = yield* Deferred.make<void>()
      yield* submit({
        key: "repo/7",
        run: Effect.sync(() => {
          results.push("latest")
        }).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid),
      })
      expect(results).toEqual([])
      yield* Deferred.succeed(finishCleanup, undefined)
      yield* Deferred.await(done)
      expect(results).toEqual(["latest"])
    }).pipe(Effect.scoped),
  )
})

test("scope closure interrupts active work without completing it", async () => {
  const started = Deferred.makeUnsafe<void>()
  let completed = false
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const submit = yield* makeIdentityWork()
      yield* submit({
        key: "repo/7",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.andThen(
            Effect.sync(() => {
              completed = true
            }),
          ),
        ),
      })
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )
  await Effect.runPromise(Deferred.await(started))
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(completed).toBe(false)
})

test("a running head with a waiting replacement does not count against two waiting heads", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cancelling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const ran = yield* Queue.unbounded<string>()
      const submit = yield* makeIdentityWork(1, 4)
      yield* submit({
        key: "a",
        prKey: "pr",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cancelling, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
      })
      yield* Deferred.await(started)
      const job = (key: string) => ({
        key,
        prKey: "pr",
        run: Queue.offer(ran, key).pipe(Effect.asVoid),
      })
      yield* submit(job("a"))
      yield* Deferred.await(cancelling)
      yield* submit(job("b"))
      yield* submit(job("c"))
      yield* Deferred.succeed(release, undefined)
      const finished = [yield* Queue.take(ran), yield* Queue.take(ran), yield* Queue.take(ran)]
      expect(finished.sort()).toEqual(["a", "b", "c"])
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  )
})

test.each(["check_run", "pull_request"])(
  "an interrupted head queued behind other PRs survives eviction (%s)",
  async (event) => {
    let comparisons = 0
    let nextId = 104
    const completed: Array<{ id: number; conclusion: unknown }> = []
    const scanning = Promise.withResolvers<void>()
    const f = fixture({
      intercept: async (path, body, signal) => {
        if (path.endsWith("/check-runs") && body.status === "in_progress")
          return Response.json({ id: nextId++ })
        if (body.status === "completed")
          completed.push({ id: Number(path.split("/").at(-1)), conclusion: body.conclusion })
        if (path.includes("/compare/")) {
          if (++comparisons === 1) {
            scanning.resolve()
            await new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true }),
            )
          }
          return Response.json({ total_commits: 0, commits: [] })
        }
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const submit = yield* makeIdentityWork(1, 6)
        const jobs = yield* f.app.identityCheckJobs("pull_request", payload())
        const initial = jobs[0]
        if (initial === undefined) throw new Error("missing job")
        yield* submit(initial)
        yield* Effect.promise(() => scanning.promise)
        const blocked = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* submit({
          key: "other/8",
          run: Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        const replacements = yield* f.app.identityCheckJobs(
          event,
          event === "pull_request"
            ? payload()
            : {
                ...payload("rerequested"),
                check_run: {
                  id: 104,
                  name: "Workflowd Git Identity",
                  app: { id: 123 },
                  external_id: "agent-git:7",
                  head_sha: "a".repeat(40),
                },
              },
        )
        const replacement = replacements[0]
        if (replacement === undefined) throw new Error("missing replacement")
        yield* submit(replacement)
        yield* Deferred.await(blocked)
        for (const key of ["b", "c"])
          yield* submit({ key, prKey: "owner/repo/7", run: Effect.void })
        const drained = yield* Deferred.make<void>()
        yield* submit({
          key: "sentinel",
          run: Deferred.succeed(drained, undefined).pipe(Effect.asVoid),
        })
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(drained)
        expect(completed).toContainEqual({ id: 104, conclusion: "failure" })
        expect(f.writes.at(-1)).toMatchObject({ status: "completed", conclusion: "success" })
      }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
    )
  },
)

test("two queued check reruns are retained when another head arrives", async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const submit = yield* makeIdentityWork(1, 4)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* submit({
        key: "other",
        run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })
      yield* Deferred.await(started)
      for (const [id, sha] of [
        [104, "a"],
        [105, "b"],
      ] as const) {
        const jobs = yield* f.app.identityCheckJobs("check_run", {
          ...payload("rerequested"),
          check_run: {
            id,
            name: "Workflowd Git Identity",
            app: { id: 123 },
            external_id: "agent-git:7",
            head_sha: sha.repeat(40),
          },
        })
        const job = jobs[0]
        if (job === undefined) throw new Error("missing job")
        expect(yield* submit(job)).toBe(true)
      }
      expect(yield* submit({ key: "c", prKey: "owner/repo/7", run: Effect.void })).toBe(false)
      const drained = yield* Deferred.make<void>()
      yield* submit({
        key: "sentinel",
        run: Deferred.succeed(drained, undefined).pipe(Effect.asVoid),
      })
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(drained)
      expect(f.writes.filter((w) => w.status === "completed").map((w) => w.conclusion)).toEqual([
        "success",
        "failure",
      ])
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")),
  )
})

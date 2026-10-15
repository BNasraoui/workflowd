import { expect, test } from "bun:test"
import { Deferred, Effect, Logger, Queue } from "effect"
import { TestClock } from "effect/testing"
import { makeIdentityCheckDispatcher } from "../src/github/identity-dispatch"
import { IdentityBudgetExhausted } from "../src/github/identity-request"
import { makeIdentityWork } from "../src/github/identity-work"
import { fixture, head, payload } from "./helpers/identity"

test("two fork flood waves leave a later trusted PR able to complete", async () => {
  const f = fixture({
    intercept: async (path) => {
      if (path.includes("/compare/")) return Response.json({ total_commits: 0, commits: [] })
    },
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* makeIdentityCheckDispatcher(f.app)
      if (dispatch === undefined) throw new Error("missing dispatcher")
      for (let wave = 0; wave < 2; wave++) {
        for (let i = 1; i <= 130; i++) {
          yield* dispatch("pull_request", {
            ...payload(),
            pull_request: {
              number: wave * 130 + i,
              user: { login: "fork-author" },
              head: { sha: head },
            },
          })
          yield* TestClock.adjust("1 millis")
        }
      }
      expect(f.writes.filter((w) => w.conclusion === "success")).toHaveLength(25)
      yield* dispatch("pull_request", {
        ...payload(),
        pull_request: {
          number: 261,
          user: { login: "maintainer" },
          author_association: "OWNER",
          head: { sha: head, repo: { full_name: "owner/repo" } },
        },
      })
      yield* TestClock.adjust("1 millis")
      expect(f.requests.filter((r) => r.body.external_id === "agent-git:261")).toHaveLength(1)
      expect(f.writes.filter((w) => w.conclusion === "success")).toHaveLength(26)
    }).pipe(Effect.scoped, Effect.provide([TestClock.layer(), Logger.layer([])])),
  )
})

test.each([false, true])(
  "full waiting set evicts the oldest deferred job without a check ID (replaced: %s)",
  async (replaced) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const submit = yield* makeIdentityWork(1, 2)
        const ran = yield* Queue.unbounded<string>()
        for (const [key, preserve] of [
          ["visible", true],
          ["oldest", false],
          ["newer", false],
        ] as const) {
          let attempts = 0
          if (replaced && key === "oldest") {
            yield* submit({ key, run: Queue.offer(ran, key).pipe(Effect.andThen(Effect.never)) })
            yield* Queue.take(ran)
          }
          yield* submit({
            key,
            preserve: () => preserve,
            run: Effect.gen(function* () {
              yield* Queue.offer(ran, key)
              if (attempts++ === 0)
                return yield* Effect.fail(new IdentityBudgetExhausted({ retryAt: 60_000 }))
            }),
          })
          expect(yield* Queue.take(ran)).toBe(key)
          yield* TestClock.adjust("1 millis")
        }
        expect(
          yield* submit({
            key: "trusted",
            trusted: true,
            run: Queue.offer(ran, "trusted").pipe(Effect.asVoid),
          }),
        ).toBe(true)
        yield* TestClock.adjust("1 millis")
        expect(yield* Queue.take(ran)).toBe("trusted")
        yield* TestClock.adjust("1 minute")
        expect(yield* Queue.take(ran)).toBe("visible")
        expect(yield* Queue.take(ran)).toBe("newer")
        expect(yield* Queue.size(ran)).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  },
)

test("trusted waiting reserve remains available when untrusted jobs already own checks", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const f = fixture()
      const started = yield* Queue.unbounded<string>()
      const release = yield* Deferred.make<void>()
      const dispatch = yield* makeIdentityCheckDispatcher({
        ...f.app,
        identityCheckJobs: (event, value) =>
          f.app.identityCheckJobs(event, value).pipe(
            Effect.map((jobs) =>
              jobs.map((job) => ({
                ...job,
                preserve: () => true,
                run: Queue.offer(started, job.key).pipe(Effect.andThen(Deferred.await(release))),
              })),
            ),
          ),
      })
      if (dispatch === undefined) throw new Error("missing dispatcher")
      for (let number = 1; number <= 104; number++) {
        yield* dispatch("pull_request", {
          ...payload(),
          pull_request: { number, head: { sha: head } },
        })
        if (number <= 4) yield* Queue.take(started)
      }
      yield* dispatch("pull_request", {
        ...payload(),
        pull_request: { number: 105, head: { sha: head }, author_association: "MEMBER" },
      })
      yield* Deferred.succeed(release, undefined)
      // 80 untrusted waiters and the trusted job; four workers were already started.
      for (let i = 0; i < 80; i++) yield* Queue.take(started)
      // A barrier also makes missing trusted admission fail without a timeout.
      yield* dispatch("pull_request", {
        ...payload(),
        pull_request: { number: 106, head: { sha: head } },
      })
      expect(yield* Queue.take(started)).toBe(`owner/repo/105/${head}`)
    }).pipe(Effect.scoped, Effect.provide([TestClock.layer(), Logger.layer([])])),
  )
})

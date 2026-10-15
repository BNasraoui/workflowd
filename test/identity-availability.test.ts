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
        const submit = yield* makeIdentityWork(1, 3)
        const ran = yield* Queue.unbounded<string>()
        for (const [key, preserve, trusted] of [
          ["trusted-waiter", false, true],
          ["visible", true, false],
          ["oldest", false, false],
          ["newer", false, false],
        ] as const) {
          let attempts = 0
          if (replaced && key === "oldest") {
            yield* submit({ key, run: Queue.offer(ran, key).pipe(Effect.andThen(Effect.never)) })
            yield* Queue.take(ran)
          }
          yield* submit({
            key,
            trusted,
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
        expect(yield* Queue.take(ran)).toBe("trusted-waiter")
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

test("startup recovery gives every untrusted PR in a 300-PR backlog a check", async () => {
  const pulls = Array.from({ length: 300 }, (_, i) => ({
    number: i + 1,
    user: { login: `fork-${i % 4}` },
    head: { sha: head },
  }))
  const f = fixture({
    suiteChecks: [],
    intercept: async (path, _body, _signal, url) => {
      if (path.endsWith("/pulls")) {
        const page = Number(url.searchParams.get("page") ?? 1)
        const next = new URL(url)
        next.searchParams.set("page", String(page + 1))
        const response = Response.json(pulls.slice((page - 1) * 100, page * 100), {
          headers: page < 3 ? { link: `<${next.toString()}>; rel="next"` } : {},
        })
        Object.defineProperty(response, "url", { value: url.toString() })
        return response
      }
      if (path.includes("/compare/")) return Response.json({ total_commits: 0, commits: [] })
    },
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* makeIdentityCheckDispatcher(f.app, [{ repository: "owner/repo", installationId: 91 }])
      yield* TestClock.adjust("24 hours")
      const checked = f.writes.filter((w) => w.status === "in_progress").map((w) => w.external_id)
      expect(new Set(checked)).toEqual(new Set(pulls.map((p) => `agent-git:${p.number}`)))
      expect(f.writes.filter((w) => w.conclusion === "success")).toHaveLength(300)
    }).pipe(Effect.scoped, Effect.provide([TestClock.layer(), Logger.layer([])])),
  )
})

test("an untrusted flood does not evict deferred trusted jobs", async () => {
  const f = fixture({
    intercept: async (path) => {
      if (path.includes("/compare/")) return Response.json({ total_commits: 0, commits: [] })
    },
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* makeIdentityCheckDispatcher(f.app)
      if (dispatch === undefined) throw new Error("missing dispatcher")
      for (let number = 1; number <= 310; number++) {
        yield* dispatch("pull_request", {
          ...payload(),
          pull_request: {
            number,
            user: { login: `author-${number}` },
            author_association: number > 80 && number <= 110 ? "OWNER" : "NONE",
            head: { sha: head },
          },
        })
        yield* TestClock.adjust("1 millis")
      }
      expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(100)
      yield* TestClock.adjust("3 hours")
      const checked = new Set(f.writes.map((w) => w.external_id))
      for (let number = 81; number <= 110; number++)
        expect(checked.has(`agent-git:${number}`)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide([TestClock.layer(), Logger.layer([])])),
  )
})

test("one untrusted author cannot fill other authors' deferred slots", async () => {
  const f = fixture({ author: () => "fork-author" })
  await Effect.runPromise(
    Effect.gen(function* () {
      const submit = yield* makeIdentityWork(4, 100, 20)
      const job = (number: number, author = "fork-author", trusted = false) =>
        f.app
          .identityCheckJobs("pull_request", {
            ...payload(),
            pull_request: {
              number,
              user: { login: author },
              author_association: trusted ? "OWNER" : "NONE",
              head: { sha: head },
            },
          })
          .pipe(
            Effect.map((jobs) => {
              const target = jobs[0]
              if (target === undefined) throw new Error("missing job")
              let attempts = 0
              return {
                ...target,
                run: Effect.gen(function* () {
                  if (attempts++ === 0)
                    return yield* Effect.fail(new IdentityBudgetExhausted({ retryAt: 60_000 }))
                }),
              }
            }),
          )
      for (let number = 1; number <= 25; number++) {
        expect(yield* submit(yield* job(number))).toBe(true)
        yield* TestClock.adjust("1 millis")
      }
      expect(yield* submit(yield* job(26, "FORK-AUTHOR"))).toBe(false)
      expect(yield* submit(yield* job(27, "other-author"))).toBe(true)
      expect(yield* submit(yield* job(28, "fork-author", true))).toBe(true)
      expect(yield* submit(yield* job(1))).toBe(true)
      yield* TestClock.adjust("1 minute")
      expect(yield* submit(yield* job(29))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

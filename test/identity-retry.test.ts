import { expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { TestClock } from "effect/testing"
import { IdentityBudgetExhausted } from "../src/github/identity-request"
import { makeIdentityCheckDispatcher } from "../src/github/identity-dispatch"
import { blocked, checkName, commit, fixture, head, payload } from "./helpers/identity"

const rerun = {
  ...payload("rerequested"),
  check_run: {
    id: 12,
    name: checkName,
    app: { id: 123 },
    external_id: "agent-git:7",
    head_sha: head,
  },
}

test("a capped rerun publishes visible budget feedback", async () => {
  const f = fixture()
  for (let i = 0; i < 25; i++) await f.run()
  await f.run("check_run", rerun)
  expect(f.writes.at(-1)).toMatchObject({
    status: "completed",
    conclusion: "failure",
    output: { summary: "scan budget exhausted, retry later" },
  })
})

test.each(["start", "finish"])(
  "a deferred %s resumes without restart and without duplicate creation",
  async (kind) => {
    const f = fixture({
      author: () => "author-7",
      suiteChecks: Array.from({ length: 51 }, (_, i) => ({
        id: i + 1,
        name: checkName,
        app: { id: 123 },
        status: "in_progress",
        external_id: "agent-git:7",
      })),
      intercept: async (path) => {
        if (path.endsWith("/pulls"))
          return Response.json([{ number: 7, user: { login: "author-7" }, head: { sha: head } }])
        if (path.includes("/compare/")) return Response.json({ total_commits: 0, commits: [] })
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        if (kind === "start") {
          for (let i = 0; i < 25; i++) yield* f.app.checkAgentGitIdentity("pull_request", payload())
        } else {
          yield* f.app.recoverIdentityChecks(
            [{ repository: "owner/repo", installationId: 91 }],
            () => Effect.void,
          )
        }
        const before = f.writes.length
        const attempted = yield* Queue.unbounded<void>()
        const dispatch = yield* makeIdentityCheckDispatcher({
          ...f.app,
          identityCheckJobs: (event, value) =>
            event === "barrier"
              ? Effect.succeed([
                  { key: "barrier", run: Queue.offer(attempted, undefined).pipe(Effect.asVoid) },
                ])
              : f.app.identityCheckJobs(event, value).pipe(
                  Effect.map((jobs) =>
                    jobs.map((job) => ({
                      ...job,
                      run: job.run.pipe(Effect.ensuring(Queue.offer(attempted, undefined))),
                    })),
                  ),
                ),
        })
        if (dispatch === undefined) throw new Error("missing dispatcher")
        yield* dispatch("pull_request", {
          ...payload(),
          pull_request: { number: 8, user: { login: "author-7" }, head: { sha: head } },
        })
        yield* Queue.take(attempted)
        yield* TestClock.adjust("1 millis")
        expect(f.writes.slice(before).filter((w) => w.status === "in_progress")).toHaveLength(
          kind === "start" ? 0 : 1,
        )
        yield* dispatch("barrier", {})
        yield* Queue.take(attempted)
        // Redelivery must not replace a deferred completion with a new check.
        yield* dispatch("pull_request", {
          ...payload(),
          pull_request: { number: 8, user: { login: "author-7" }, head: { sha: head } },
        })
        yield* TestClock.adjust("1 hour")
        yield* Queue.take(attempted)
        expect(f.writes.at(-1)?.conclusion).toBe("success")
        expect(
          f.requests.filter((r) => r.method === "POST" && r.body.external_id === "agent-git:8"),
        ).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  },
)

test("a read share exhausted mid-range rescans and finds the later blocked commit", async () => {
  const pages: number[] = []
  const f = fixture({
    suiteChecks: [],
    intercept: async (path, _body, _signal, url) => {
      // Two check-page reads for each PR leave this author only two reads.
      if (path.endsWith("/pulls"))
        return Response.json(
          Array.from({ length: 124 }, (_, i) => ({
            number: i + 100,
            user: { login: "author-7" },
            head: { sha: head },
          })),
        )
      if (path.includes("/compare/")) {
        const page = Number(url.searchParams.get("page"))
        pages.push(page)
        return Response.json({
          total_commits: 101,
          commits:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => commit(i.toString(16).padStart(40, "0")))
              : [commit(head, blocked)],
        })
      }
    },
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* f.app.recoverIdentityChecks(
        [{ repository: "owner/repo", installationId: 91 }],
        () => Effect.void,
      )
      const dispatch = yield* makeIdentityCheckDispatcher(f.app)
      if (dispatch === undefined) throw new Error("missing dispatcher")
      yield* dispatch("pull_request", payload())
      yield* TestClock.adjust("1 millis")
      expect(pages).toEqual([1])
      expect(f.writes.at(-1)).toMatchObject({
        conclusion: "failure",
        output: { summary: "scan budget exhausted, retry later" },
      })
      yield* TestClock.adjust("61 minutes")
      expect(pages).toEqual([1, 1, 2])
      expect(f.writes.at(-1)).toMatchObject({
        conclusion: "failure",
        output: { summary: `${head}: author` },
      })
      expect(f.writes.some((w) => w.conclusion === "success")).toBe(false)
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test("a deferred retry re-reads trust after a collaborator is demoted", async () => {
  const options = {
    author: () => "author-7",
    association: "COLLABORATOR",
    intercept: async (path: string) =>
      path.includes("/compare/") ? Response.json({ total_commits: 0, commits: [] }) : undefined,
  }
  const f = fixture(options)
  const trustedPull = (number: number) => ({
    ...payload(),
    pull_request: { ...payload().pull_request, number, author_association: "COLLABORATOR" },
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < 25; i++)
        yield* f.app.checkAgentGitIdentity("pull_request", trustedPull(7))
      yield* TestClock.adjust("30 minutes")
      const dispatch = yield* makeIdentityCheckDispatcher(f.app)
      if (dispatch === undefined) throw new Error("missing dispatcher")
      yield* dispatch("pull_request", trustedPull(7))
      yield* TestClock.adjust("1 millis")
      for (let number = 100; number < 125; number++)
        yield* f.app.checkAgentGitIdentity("pull_request", trustedPull(number))
      const before = f.writes.length
      const reads = f.requests.filter((r) => r.path.endsWith("/pulls/7")).length
      options.association = "NONE"
      yield* TestClock.adjust("31 minutes")
      expect(f.requests.filter((r) => r.path.endsWith("/pulls/7"))).toHaveLength(reads + 1)
      expect(f.writes).toHaveLength(before)
      yield* TestClock.adjust("31 minutes")
      expect(f.writes.at(-1)?.conclusion).toBe("success")
      expect(f.writes).toHaveLength(before + 2)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test("retry trust lookup charges the author after the PR budget history expires", async () => {
  const f = fixture({
    author: () => "author-7",
    suiteChecks: [],
    intercept: async (path) => {
      if (path.endsWith("/pulls"))
        return Response.json(
          Array.from({ length: 125 }, (_, i) => ({
            number: i + 100,
            user: { login: "author-7" },
            head: { sha: head },
          })),
        )
      if (path.includes("/compare/")) return Response.json({ total_commits: 0, commits: [] })
    },
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < 25; i++) yield* f.app.checkAgentGitIdentity("pull_request", payload())
      const [job] = yield* f.app.identityCheckJobs("pull_request", payload())
      if (job === undefined) throw new Error("missing job")
      expect(yield* job.run.pipe(Effect.flip)).toBeInstanceOf(IdentityBudgetExhausted)
      yield* TestClock.adjust("61 minutes")
      yield* f.app.recoverIdentityChecks(
        [{ repository: "owner/repo", installationId: 91 }],
        () => Effect.void,
      )
      const reads = f.requests.filter((r) => r.path.endsWith("/pulls/7")).length
      expect(yield* job.run.pipe(Effect.flip)).toBeInstanceOf(IdentityBudgetExhausted)
      expect(f.requests.filter((r) => r.path.endsWith("/pulls/7"))).toHaveLength(reads)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

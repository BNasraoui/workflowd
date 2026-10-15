import { expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { TestClock } from "effect/testing"
import { makeIdentityCheckDispatcher } from "../src/github/identity-dispatch"
import { checkName, fixture, head, payload } from "./helpers/identity"

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

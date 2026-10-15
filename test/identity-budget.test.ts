import { expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { fixture, payload, head, checkName, commit } from "./helpers/identity"

const suite = {
  ...payload("rerequested"),
  check_suite: { id: 44, app: { id: 123 }, head_sha: head },
}

test("suite discovery charges every page and shares the recovery read allowance", async () => {
  let suitePages = 0
  let recoveryReads = 0
  const f = fixture({
    intercept: async (path, _body, _signal, url) => {
      if (path.endsWith("/pulls")) {
        recoveryReads++
        return Response.json([{ number: 7, head: { sha: head } }])
      }
      if (path.includes(`/commits/${head}/check-runs`)) {
        suitePages++
        const response = Response.json(
          { total_count: 200000, check_runs: [] },
          {
            headers: { link: `<${url.origin}${url.pathname}?page=${suitePages + 1}>; rel="next"` },
          },
        )
        Object.defineProperty(response, "url", { value: url.toString() })
        // Bound the old unmetered implementation so this regression fails promptly.
        if (suitePages > 1001) return Response.json({ total_count: 0, check_runs: [] })
        return response
      }
    },
  })
  await Effect.runPromise(f.app.identityCheckJobs("check_suite", suite).pipe(Effect.ignore))
  expect(suitePages).toBe(1000)
  await Effect.runPromise(
    f.app.recoverIdentityChecks(
      [{ repository: "owner/repo", installationId: 91 }],
      () => Effect.void,
    ),
  )
  expect(recoveryReads).toBe(0)
})

test("recovery charges both pull and check pagination to the installation allowance", async () => {
  let reads = 0
  let pulls = 0
  const f = fixture({
    intercept: async (path, _body, _signal, url) => {
      reads++
      const response = Response.json(
        path.endsWith("/pulls")
          ? [{ number: ++pulls, head: { sha: head } }]
          : { total_count: 0, check_runs: [] },
      )
      Object.defineProperty(response, "url", { value: url.toString() })
      return response
    },
  })
  // Each one-page iterator's completion conservatively consumes a slot too.
  for (let i = 0; i < 300; i++)
    await Effect.runPromise(
      f.app
        .recoverIdentityChecks(
          [{ repository: "owner/repo", installationId: 91 }],
          () => Effect.void,
        )
        .pipe(Effect.provide(Logger.layer([]))),
    )
  expect(pulls).toBe(250)
  expect(reads).toBe(500)
  const before = reads
  await Effect.runPromise(f.app.identityCheckJobs("check_suite", suite).pipe(Effect.ignore))
  expect(reads).toBe(before)
})

test("a push and rerun flood stops starting checks while leaving completion capacity", async () => {
  const f = fixture({ config: false })
  // Spread across PRs so the installation write limit is independently exercised.
  for (let number = 1; number <= 105; number++)
    await f.run("pull_request", {
      ...payload(),
      pull_request: { number, head: { sha: head } },
    })
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(100)
  expect(
    f.writes.filter((w) => w.status === "completed" && w.conclusion === "failure"),
  ).toHaveLength(100)
  await f.run("check_run", {
    ...payload("rerequested"),
    check_run: {
      id: 12,
      name: checkName,
      app: { id: 123 },
      external_id: "agent-git:106",
      head_sha: head,
    },
  })
  expect(f.writes).toHaveLength(200)
  await f.run("pull_request", { ...payload(), installation: { id: 92 } })
  expect(f.writes).toHaveLength(202)
})

test("one fork's repeated scans leave inspection capacity for another PR", async () => {
  let reads = 0
  const f = fixture({
    intercept: async (path, _body, _signal, url) => {
      if (path.includes("/compare/")) {
        reads++
        const page = Number(url.searchParams.get("page"))
        return Response.json({
          total_commits: 10000,
          commits: Array.from({ length: 100 }, (_, i) =>
            commit((page * 100 + i).toString(16).padStart(40, "0")),
          ),
        })
      }
      if (path.endsWith("/pulls/7")) reads++
    },
  })
  for (let i = 0; i < 11; i++) await f.run()
  expect(reads).toBe(250)
  expect(f.writes.at(-1)).toMatchObject({
    conclusion: "failure",
    output: { summary: "scan budget exhausted, retry later" },
  })
  await f.run("pull_request", { ...payload(), pull_request: { number: 8, head: { sha: head } } })
  expect(f.writes.at(-1)?.conclusion).toBe("success")
})

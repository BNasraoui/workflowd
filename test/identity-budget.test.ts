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

const pullFor = (number: number, author: string) => ({
  ...payload(),
  pull_request: { number, user: { login: author }, head: { sha: head } },
})

test("four PRs from one author share starts and leave another author's check available", async () => {
  const f = fixture()
  for (let i = 0; i < 100; i++) await f.run("pull_request", pullFor(7 + (i % 4), "fork-author"))
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(25)
  await f.run("pull_request", pullFor(20, "maintainer"))
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(26)
  expect(f.writes.at(-1)?.conclusion).toBe("success")
})

test("four PRs from one author share inspection reads", async () => {
  let reads = 0
  const f = fixture({
    intercept: async (path, _body, _signal, url) => {
      if (path.includes("/pulls/")) reads++
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
    },
  })
  for (let i = 0; i < 4; i++) await f.run("pull_request", pullFor(7 + i, "fork-author"))
  expect(reads).toBe(250)
  await f.run("pull_request", pullFor(20, "maintainer"))
  expect(f.writes.at(-1)?.conclusion).toBe("success")
})

test("per-PR starts cap forty deliveries at twenty-five and leave another PR available", async () => {
  const f = fixture()
  // Vary the author to isolate PR accounting from the independent author share.
  for (let i = 0; i < 40; i++) await f.run("pull_request", pullFor(7, `author-${i}`))
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(25)
  await f.run("pull_request", pullFor(8, "other"))
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(26)
  expect(f.writes.at(-1)?.conclusion).toBe("success")
})

test("per-PR rerun resets stop at twenty-five and leave another PR available", async () => {
  let lookup = 0
  const f = fixture({ author: () => `author-${lookup++}` })
  const rerun = (number: number) => ({
    ...payload("rerequested"),
    check_run: {
      id: 12,
      name: checkName,
      app: { id: 123 },
      external_id: `agent-git:${number}`,
      head_sha: head,
    },
  })
  for (let i = 0; i < 40; i++) await f.run("check_run", rerun(7))
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(25)
  await f.run("check_run", rerun(8))
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(26)
  expect(f.writes.at(-1)?.conclusion).toBe("success")
})

test.each([false, true])(
  "per-PR completions and author completions share recovery's fifty-write cap (author share: %s)",
  async (authorShare) => {
    const f = fixture({
      suiteChecks: Array.from({ length: 51 }, (_, i) => ({
        id: i + 1,
        name: checkName,
        app: { id: 123 },
        status: "in_progress",
        external_id: "agent-git:7",
      })),
      intercept: async (path) => {
        if (path.endsWith("/pulls"))
          return Response.json([
            { number: 7, user: { login: "recovery-author" }, head: { sha: head } },
          ])
      },
    })
    await Effect.runPromise(
      f.app.recoverIdentityChecks(
        [{ repository: "owner/repo", installationId: 91 }],
        () => Effect.void,
      ),
    )
    expect(f.writes.filter((w) => w.status === "completed")).toHaveLength(50)
    await f.run(
      "pull_request",
      pullFor(authorShare ? 8 : 7, authorShare ? "recovery-author" : "scan-author"),
    )
    expect(f.writes.filter((w) => w.status === "completed")).toHaveLength(50)
    expect(f.writes.at(-1)?.status).toBe("in_progress")
    await f.run("pull_request", pullFor(9, "other"))
    expect(f.writes.at(-1)?.conclusion).toBe("success")
  },
)

test("rerun author lookups cannot bypass the shared author read allowance", async () => {
  const f = fixture({ author: () => "fork-author" })
  for (let i = 0; i < 300; i++)
    await f.run("check_run", {
      ...payload("rerequested"),
      check_run: {
        id: 12,
        name: checkName,
        app: { id: 123 },
        external_id: `agent-git:${7 + (i % 4)}`,
        head_sha: head,
      },
    })
  expect(f.requests.filter((r) => r.method === "GET").length).toBeLessThanOrEqual(250)
  await f.run("pull_request", pullFor(20, "maintainer"))
  expect(f.writes.at(-1)?.conclusion).toBe("success")
})

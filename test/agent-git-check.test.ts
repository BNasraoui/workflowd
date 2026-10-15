import { expect, test } from "bun:test"
import { Effect } from "effect"
import { GitHubAppAdapter } from "../src/github"
import {
  head,
  base,
  blocked,
  allowed,
  checkName,
  commit,
  payload,
  fixture,
} from "./helpers/identity"

test.each(["opened", "synchronize", "reopened", "edited"])(
  "checks a draft fork on %s using immutable base..head",
  async (action) => {
    const f = fixture()
    await f.run("pull_request", { ...payload(action), changes: { base: { ref: { from: "old" } } } })
    expect(f.writes[0]).toMatchObject({ name: checkName, head_sha: head, status: "in_progress" })
    expect(f.writes.at(-1)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(
      f.requests.some((r) => r.path.includes(`/compare/${base}...${head}?per_page=100&page=1`)),
    ).toBe(true)
  },
)

test("inspects all pages and both raw Git roles, including API-created commits", async () => {
  const f = fixture()
  await f.client.rest.git.createCommit({
    owner: "owner",
    repo: "repo",
    message: "API bypasses hooks",
    tree: base,
    parents: [base],
    author: { name: "author", email: blocked.toUpperCase() },
    committer: { name: "committer", email: blocked },
  })
  await f.run()
  expect(f.writes.at(-1)).toMatchObject({
    conclusion: "failure",
    output: { summary: `${head}: author, committer` },
  })
  expect(JSON.stringify(f.writes)).not.toContain("@")
  const paginated = fixture({
    pages: [
      { total_commits: 2, commits: [commit("c".repeat(40))] },
      { total_commits: 2, commits: [commit(head, allowed, blocked)] },
    ],
  })
  await paginated.run()
  expect(paginated.writes.at(-1)).toMatchObject({
    conclusion: "failure",
    output: { summary: `${head}: committer` },
  })
})

test.each([
  { errorPath: "/compare/" },
  { errorPath: "/pulls/" },
  { config: false },
  { changedHead: true },
  { changeBaseDuringScan: true },
  { changeHeadDuringScan: true },
  { closedAfter: true },
  { closedBefore: true },
  { wrongNumber: true },
  { pages: [{ total_commits: 0, commits: [commit(head)] }] },
  {
    pages: [
      { total_commits: 2, commits: [commit(head)] },
      { total_commits: 1, commits: [commit("c".repeat(40))] },
    ],
  },
  {
    pages: [
      { total_commits: 2, commits: [commit(head)] },
      { total_commits: 2, commits: [] },
    ],
  },
  { pages: [{ total_commits: 2, commits: [commit(head), commit(head)] }] },
  { pages: [{ total_commits: 1, commits: [commit(blocked)] }] },
  {
    pages: [
      { total_commits: 1, commits: [{ sha: head, commit: { author: null, committer: null } }] },
    ],
  },
])("fails closed without leaking API or decode errors", async (options) => {
  const f = fixture(options)
  await f.run()
  expect(f.requests.filter((r) => r.path.includes("/compare/")).length).toBeLessThanOrEqual(2)
  expect(f.writes.at(-1)).toMatchObject({ conclusion: "failure" })
  expect(JSON.stringify(f.writes)).not.toContain("@")
})

test("reruns only this App's identity check, resetting the old result before reading", async () => {
  const f = fixture()
  const rerun = {
    ...payload(),
    action: "rerequested",
    check_run: {
      id: 12,
      name: checkName,
      app: { id: 123 },
      external_id: "agent-git:7",
      head_sha: head,
    },
  }
  await f.run("check_run", rerun)
  expect(f.requests[0]).toMatchObject({
    method: "PATCH",
    path: "/repos/owner/repo/check-runs/12",
    body: { status: "in_progress" },
  })
  expect(f.writes.at(-1)).toMatchObject({ conclusion: "success" })
  for (const value of [
    { ...rerun, action: "completed" },
    { ...rerun, check_run: { ...rerun.check_run, app: { id: 999 } } },
    { ...rerun, check_run: { ...rerun.check_run, name: "Other" } },
    { ...rerun, check_run: { ...rerun.check_run, app: { id: 999 }, external_id: null } },
    { ...rerun, check_run: { ...rerun.check_run, external_id: "other:7" } },
  ]) {
    const ignored = fixture()
    await ignored.run("check_run", value)
    expect(ignored.requests).toEqual([])
  }
})

test("check write and installation errors remain sanitized failures", async () => {
  const f = fixture({ errorPath: "/check-runs" })
  await expect(f.run()).rejects.toThrow("Git identity check unavailable")
  const app = new GitHubAppAdapter(
    123,
    async () => {
      throw new Error(blocked)
    },
    undefined,
    undefined,
    [blocked],
  )
  await expect(
    Effect.runPromise(app.checkAgentGitIdentity("pull_request", payload())),
  ).rejects.toThrow("Git identity check unavailable")
})

test("ignores unrelated events and PR actions", async () => {
  const f = fixture()
  await f.run("push", payload())
  await f.run("pull_request", payload("closed"))
  expect(f.requests).toEqual([])
})

test("checks beyond GitHub's default 250-commit limit and bounds failure output", async () => {
  const commits = Array.from({ length: 1001 }, (_, index) =>
    commit(index.toString(16).padStart(40, "0"), blocked),
  )
  const pages = Array.from({ length: 11 }, (_, index) => ({
    total_commits: commits.length,
    commits: commits.slice(index * 100, (index + 1) * 100),
  }))
  const f = fixture({ pages })
  await f.run()
  expect(f.requests.filter((r) => r.path.includes("/compare/"))).toHaveLength(11)
  const result = JSON.stringify(f.writes.at(-1))
  expect(result).toContain("failure")
  expect(result).toContain("101 additional failing commits omitted")
  expect(result).not.toContain("@")
  expect(result.length).toBeLessThan(65535)
})

test("empty configured blocklist fails closed; failed publication stays pending", async () => {
  const empty = fixture({
    emptyPolicy: true,
    pages: [{ total_commits: 1, commits: [commit(head, blocked)] }],
  })
  await empty.run()
  expect(empty.writes.at(-1)).toMatchObject({ conclusion: "failure" })
  const failed = fixture({ failCompletion: true })
  await expect(failed.run()).rejects.toThrow("Git identity check unavailable")
  expect(failed.writes).toHaveLength(1)
  expect(failed.writes[0]).toMatchObject({ status: "in_progress" })
})

test("whitespace-only policy fails closed", async () => {
  const f = fixture({ policy: [" ", "\t"] })
  await f.run()
  expect(f.writes.at(-1)).toMatchObject({ conclusion: "failure" })
})

test("normalizes the configured blocklist", async () => {
  const f = fixture({
    policy: [` \t${blocked.toUpperCase()}\n`],
    pages: [{ total_commits: 1, commits: [commit(head, blocked)] }],
  })
  await f.run()
  expect(f.writes.at(-1)).toMatchObject({
    conclusion: "failure",
    output: { summary: `${head}: author` },
  })
})

test("rejects a changing total even when the final unique count matches", async () => {
  const f = fixture({
    pages: [
      { total_commits: 3, commits: [commit(head)] },
      { total_commits: 2, commits: [commit("c".repeat(40))] },
    ],
  })
  await f.run()
  expect(f.writes.at(-1)).toMatchObject({ conclusion: "failure" })
})

test("sanitizes malformed event decode failures", async () => {
  const f = fixture()
  await expect(
    f.run("pull_request", { ...payload(), installation: { id: blocked } }),
  ).rejects.toThrow(/^Git identity check unavailable$/)
  expect(f.requests).toEqual([])
})

test("ignores edits without a base change", async () => {
  const f = fixture()
  for (const changes of [
    undefined,
    {},
    { title: { from: "before" } },
    { body: { from: "before" } },
  ]) {
    await f.run("pull_request", { ...payload("edited"), changes })
  }
  expect(f.requests).toEqual([])
})

test.each([false, true])(
  "check_suite rerequested resets its identity checks even without fork PR references: %s",
  async (fork) => {
    const suite = {
      ...payload("rerequested"),
      check_suite: {
        id: 44,
        app: { id: 123 },
        head_sha: head,
        pull_requests: fork ? [] : [{ number: 7 }, { number: 8 }],
      },
    }
    const f = fixture()
    await f.run("check_suite", suite)
    expect(f.writes.at(-1)).toMatchObject({ conclusion: "success" })
    expect(f.writes[0]).toMatchObject({ status: "in_progress", external_id: "agent-git:7" })
    expect(f.requests.some((r) => r.method === "PATCH" && r.path.endsWith("/check-runs/17"))).toBe(
      true,
    )
    expect(f.writes[2]).toMatchObject({ status: "in_progress", external_id: "agent-git:8" })
    expect(f.writes).toHaveLength(4)
    for (const value of [
      { ...suite, action: "completed" },
      { ...suite, check_suite: { ...suite.check_suite, app: { id: 999 } } },
    ]) {
      const ignored = fixture()
      await ignored.run("check_suite", value)
      expect(ignored.requests).toEqual([])
    }
  },
)

test("suite reruns ignore checks from other apps, suites, names, and external IDs", async () => {
  const own = {
    id: 17,
    name: checkName,
    app: { id: 123 },
    check_suite: { id: 44 },
    external_id: "agent-git:7",
  }
  const f = fixture({
    suiteChecks: [
      { ...own, app: { id: 999 } },
      { ...own, check_suite: { id: 99 } },
      { ...own, name: "Other" },
      { ...own, external_id: "other:7" },
      { ...own, external_id: null },
    ],
  })
  await f.run("check_suite", {
    ...payload("rerequested"),
    check_suite: { id: 44, app: { id: 123 }, head_sha: head, pull_requests: [] },
  })
  expect(f.writes).toEqual([])
})

test("suite reruns paginate existing checks", async () => {
  const f = fixture({
    suiteChecks: Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: checkName,
      app: { id: 123 },
      check_suite: { id: index === 100 ? 44 : 99 },
      external_id: "agent-git:7",
    })),
  })
  await f.run("check_suite", {
    ...payload("rerequested"),
    check_suite: { id: 44, app: { id: 123 }, head_sha: head, pull_requests: [] },
  })
  expect(
    f.requests.filter((r) => r.method === "GET" && r.path.includes("/check-runs")),
  ).toHaveLength(2)
  expect(f.writes.at(-1)).toMatchObject({ conclusion: "success" })
})

test("caps a range at 10000 commits with an explicit failure", async () => {
  const f = fixture({ pages: [{ total_commits: 10001, commits: [commit(head)] }] })
  await f.run()
  expect(f.requests.filter((r) => r.path.includes("/compare/"))).toHaveLength(1)
  expect(f.writes.at(-1)).toMatchObject({
    conclusion: "failure",
    output: { summary: "range too large" },
  })
})

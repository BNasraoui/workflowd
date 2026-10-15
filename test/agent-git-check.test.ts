import { expect, test } from "bun:test"
import { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import { GitHubAppAdapter } from "../src/github"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "../src/github/adapter"

const head = "a".repeat(40)
const base = "b".repeat(40)
const blocked = ["blocked", "example.invalid"].join("@")
const allowed = ["agent", "example.invalid"].join("@")
const checkName = "Workflowd Git Identity"
const commit = (sha: string, author = allowed, committer = allowed) => ({
  sha,
  commit: { author: { email: author }, committer: { email: committer }, message: blocked },
  author: null,
  committer: null,
})
const payload = (action = "opened") => ({
  action,
  installation: { id: 91 },
  repository: { full_name: "owner/repo" },
  pull_request: { number: 7, head: { sha: head } },
})

function fixture(
  options: {
    pages?: ReadonlyArray<unknown>
    errorPath?: string
    config?: boolean
    changedHead?: boolean
    changeBaseDuringScan?: boolean
    emptyPolicy?: boolean
    failCompletion?: boolean
  } = {},
) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const writes: Array<Record<string, unknown>> = []
  const apiCommits: Array<ReturnType<typeof commit>> = []
  let pulls = 0
  const client = new Octokit({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = init?.method ?? "GET"
        const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        )
        requests.push({ method, path: url.pathname + url.search, body })
        if (url.pathname.includes(options.errorPath ?? "NEVER"))
          return Response.json({ message: blocked }, { status: 503 })
        if (url.pathname.endsWith("/git/commits")) {
          const identity = Schema.decodeUnknownSync(
            Schema.Struct({
              author: Schema.Struct({ email: Schema.String }),
              committer: Schema.Struct({ email: Schema.String }),
            }),
          )(body)
          const created = commit(head, identity.author.email, identity.committer.email)
          apiCommits.push(created)
          return Response.json(created, { status: 201 })
        }
        if (url.pathname.includes("/check-runs")) {
          if (options.failCompletion && method === "PATCH")
            return Response.json({ message: blocked }, { status: 503 })
          writes.push(body)
          return Response.json({ id: 12 }, { status: method === "POST" ? 201 : 200 })
        }
        if (url.pathname.includes("/compare/")) {
          const pages = options.pages ?? [
            { total_commits: 1, commits: apiCommits.length ? apiCommits : [commit(head)] },
          ]
          return Response.json(pages[Number(url.searchParams.get("page") ?? 1) - 1])
        }
        if (url.pathname.endsWith("/pulls/7")) {
          pulls++
          return Response.json({
            number: 7,
            user: { login: "author" },
            draft: true,
            state: "open",
            base: {
              ref: "main",
              sha: options.changeBaseDuringScan && pulls > 1 ? "d".repeat(40) : base,
              repo: { id: 1, full_name: "owner/repo", name: "repo", owner: { login: "owner" } },
            },
            head: {
              ref: "feature",
              sha: options.changedHead ? "c".repeat(40) : head,
              repo: { full_name: "fork/repo" },
            },
          })
        }
        throw new Error(`Unexpected request: ${method} ${url.pathname}`)
      },
    },
  })
  const app = new GitHubAppAdapter(
    123,
    async () => new OctokitInstallationAdapter(makeOctokitClientPort(client)),
    undefined,
    undefined,
    options.config === false ? undefined : options.emptyPolicy ? [] : [blocked],
  )
  const run = (event = "pull_request", value: unknown = payload()) =>
    Effect.runPromise(app.checkAgentGitIdentity(event, value))
  return { client, run, writes, requests }
}

test.each(["opened", "synchronize", "reopened", "edited"])(
  "checks a draft fork on %s using immutable base..head",
  async (action) => {
    const f = fixture()
    await f.run("pull_request", payload(action))
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

test("empty configured blocklist still scans and passes; failed publication stays pending", async () => {
  const empty = fixture({
    emptyPolicy: true,
    pages: [{ total_commits: 1, commits: [commit(head, blocked)] }],
  })
  await empty.run()
  expect(empty.writes.at(-1)).toMatchObject({ conclusion: "success" })
  const failed = fixture({ failCompletion: true })
  await expect(failed.run()).rejects.toThrow("Git identity check unavailable")
  expect(failed.writes).toHaveLength(1)
  expect(failed.writes[0]).toMatchObject({ status: "in_progress" })
})

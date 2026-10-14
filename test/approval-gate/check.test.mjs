import { expect, test } from "bun:test"
import { runGate, githubRequest } from "../../deploy/approval-gate/check.mjs"

test("REST transport separates read and App write credentials and hides error bodies", async () => {
  const originalFetch = globalThis.fetch
  const oldRead = process.env.GITHUB_TOKEN
  const oldApp = process.env.APP_TOKEN
  const requests = []
  process.env.GITHUB_TOKEN = "read-fixture"
  process.env.APP_TOKEN = "app-fixture"
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options })
      return new Response('{"id":1}', { status: 200 })
    }
    await githubRequest("/read")
    await githubRequest("/write", { head_sha: "a".repeat(40) })
    expect(requests[0].options.headers.Authorization).toBe("Bearer read-fixture")
    expect(requests[1].options.headers.Authorization).toBe("Bearer app-fixture")
    expect(requests[1].options).toMatchObject({ method: "POST", redirect: "error" })
    globalThis.fetch = async () => new Response("private response", { status: 403 })
    await expect(githubRequest("/read")).rejects.toThrow("GitHub GET failed: HTTP 403")
    delete process.env.APP_TOKEN
    await expect(githubRequest("/write", {})).rejects.toThrow("Missing scoped GitHub token")
  } finally {
    globalThis.fetch = originalFetch
    if (oldRead === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = oldRead
    if (oldApp === undefined) delete process.env.APP_TOKEN
    else process.env.APP_TOKEN = oldApp
  }
})

const sha = "a".repeat(40)
const root = "/repos/BNasraoui/workflowd"
function fixture() {
  const env = {
    GITHUB_REPOSITORY: "BNasraoui/workflowd",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    APPROVAL_ACTION: "approve",
    BEN_APPROVAL_APP_ID: "98765",
    PR_NUMBER: "42",
    HEAD_SHA: sha,
  }
  const pr = {
    state: "open",
    merged: false,
    draft: false,
    base: { ref: "main", repo: { full_name: "BNasraoui/workflowd" } },
    head: { sha },
    requested_reviewers: [],
    requested_teams: [],
  }
  const responses = new Map([
    [`${root}/pulls/42`, pr],
    [
      `${root}/actions/runs/123/approvals`,
      [
        {
          state: "approved",
          user: { id: 81005232 },
          environments: [{ name: "ben-merge-approval" }],
        },
      ],
    ],
    [`${root}/pulls/42/reviews?per_page=100&page=1`, []],
    [
      `${root}/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`,
      {
        check_runs: [
          {
            name: "Required checks",
            app: { id: 15368 },
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
    [`${root}/commits/${sha}/status?per_page=100&page=1`, { statuses: [] }],
  ])
  const writes = []
  const reads = []
  const request = async (path, body) => {
    if (body) {
      writes.push({ path, body })
      return { id: 1 }
    }
    reads.push(path)
    if (!responses.has(path)) throw new Error(`Unexpected request: ${path}`)
    return structuredClone(responses.get(path))
  }
  return { env, pr, responses, writes, reads, request }
}

test("only publish posts an App check on the supplied, verified PR head", async () => {
  const f = fixture()
  await runGate("validate", f.env, f.request)
  expect(f.writes).toEqual([])
  await runGate("publish", f.env, f.request)
  expect(f.writes).toHaveLength(1)
  expect(f.writes[0]).toMatchObject({
    path: `${root}/check-runs`,
    body: {
      name: "Ben approval",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      details_url: "https://github.com/BNasraoui/workflowd/actions/runs/123",
    },
  })
  expect(f.reads.filter((path) => path === `${root}/pulls/42`)).toHaveLength(4)
})

for (const [key, value] of Object.entries({
  APPROVAL_ACTION: "unexpected",
  BEN_APPROVAL_APP_ID: "invalid",
  GITHUB_REPOSITORY: "other/repo",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REF: "refs/heads/topic",
  GITHUB_RUN_ATTEMPT: "2",
  PR_NUMBER: "42;echo",
  HEAD_SHA: "main",
  GITHUB_RUN_ID: "invalid",
}))
  test(`refuses invalid context/input ${key} before API access`, async () => {
    const f = fixture()
    f.env[key] = value
    await expect(runGate("publish", f.env, f.request)).rejects.toThrow()
    expect(f.reads).toEqual([])
    expect(f.writes).toEqual([])
  })

for (const change of [
  { state: "closed" },
  { merged: true },
  { draft: true },
  { head: { sha: "b".repeat(40) } },
  { base: { ref: "other", repo: { full_name: "BNasraoui/workflowd" } } },
  { requested_reviewers: [{ id: 2 }] },
  { requested_teams: [{ id: 3 }] },
])
  test(`refuses ineligible PR ${JSON.stringify(change)}`, async () => {
    const f = fixture()
    Object.assign(f.pr, change)
    await expect(runGate("publish", f.env, f.request)).rejects.toThrow()
    expect(f.writes).toEqual([])
  })

for (const approvals of [
  [],
  [{ state: "approved", user: { id: 2 }, environments: [{ name: "ben-merge-approval" }] }],
  [{ state: "rejected", user: { id: 81005232 }, environments: [{ name: "ben-merge-approval" }] }],
])
  test("requires recorded Ben approval for this environment", async () => {
    const f = fixture()
    f.responses.set(`${root}/actions/runs/123/approvals`, approvals)
    await expect(runGate("publish", f.env, f.request)).rejects.toThrow()
    expect(f.writes).toEqual([])
  })

for (const state of ["PENDING", "CHANGES_REQUESTED"])
  test(`refuses visible ${state} reviews`, async () => {
    const f = fixture()
    f.responses.set(`${root}/pulls/42/reviews?per_page=100&page=1`, [
      { id: 1, user: { id: 2 }, state },
    ])
    await expect(runGate("publish", f.env, f.request)).rejects.toThrow()
    expect(f.writes).toEqual([])
  })

test("a later approval supersedes a submitted change request", async () => {
  const f = fixture()
  f.responses.set(`${root}/pulls/42/reviews?per_page=100&page=1`, [
    { id: 1, user: { id: 2 }, state: "CHANGES_REQUESTED" },
    { id: 2, user: { id: 2 }, state: "APPROVED" },
  ])
  await runGate("publish", f.env, f.request)
  expect(f.writes).toHaveLength(1)
})

test("refuses pending optional review checks on later pages", async () => {
  const f = fixture()
  const first = f.responses.get(
    `${root}/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`,
  )
  first.check_runs.push(
    ...Array.from({ length: 99 }, () => ({
      name: "other",
      status: "completed",
      conclusion: "success",
    })),
  )
  f.responses.set(`${root}/commits/${sha}/check-runs?filter=latest&per_page=100&page=2`, {
    check_runs: [{ name: "OpenCode Review", status: "queued", conclusion: null }],
  })
  await expect(runGate("publish", f.env, f.request)).rejects.toThrow()
  expect(f.writes).toEqual([])
})

test("refuses pending legacy commit statuses", async () => {
  const f = fixture()
  f.responses.set(`${root}/commits/${sha}/status?per_page=100&page=1`, {
    statuses: [{ context: "review", state: "pending" }],
  })
  await expect(runGate("publish", f.env, f.request)).rejects.toThrow()
  expect(f.writes).toEqual([])
})

test("API failure and a head change during validation never post success", async () => {
  for (const fail of [true, false]) {
    const f = fixture()
    let count = 0
    const request = async (path, body) => {
      if (path === `${root}/pulls/42` && ++count === 2) {
        if (fail) throw new Error("API unavailable")
        f.pr.head.sha = "b".repeat(40)
      }
      return f.request(path, body)
    }
    await expect(runGate("publish", f.env, request)).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
})

test("revocation posts a newer failing check for the SHA without depending on PR or CI state", async () => {
  const f = fixture()
  await runGate("publish", f.env, f.request)
  f.env.APPROVAL_ACTION = "revoke"
  delete f.env.PR_NUMBER
  // Closed, moved, or reused PRs and failing reviews/checks cannot prevent revocation.
  for (const path of f.responses.keys()) if (!path.endsWith("/approvals")) f.responses.delete(path)
  f.reads.length = 0
  await runGate("validate", f.env, f.request)
  expect(f.writes).toHaveLength(1)
  await runGate("publish", f.env, f.request)
  expect(f.writes).toHaveLength(2)
  expect(f.writes[1]).toMatchObject({
    path: `${root}/check-runs`,
    body: {
      name: f.writes[0].body.name,
      head_sha: sha,
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.com/BNasraoui/workflowd/actions/runs/123",
      output: { title: "Ben revoked approval for this commit" },
    },
  })
  expect(f.reads).toEqual(Array(2).fill(`${root}/actions/runs/123/approvals`))
})

for (const [key, value] of [
  ["GITHUB_REF", "refs/heads/topic"],
  ["GITHUB_RUN_ATTEMPT", "2"],
  ["HEAD_SHA", "main"],
])
  test(`revocation refuses invalid ${key} before API access`, async () => {
    const f = fixture()
    Object.assign(f.env, { APPROVAL_ACTION: "revoke", [key]: value })
    await expect(runGate("publish", f.env, f.request)).rejects.toThrow()
    expect(f.reads).toEqual([])
    expect(f.writes).toEqual([])
  })

test("revocation still requires Ben's protected environment approval", async () => {
  const f = fixture()
  f.env.APPROVAL_ACTION = "revoke"
  f.responses.set(`${root}/actions/runs/123/approvals`, [])
  await expect(runGate("publish", f.env, f.request)).rejects.toThrow(
    "recorded environment approval",
  )
  expect(f.writes).toEqual([])
})

for (const appId of [98765, 12345])
  test(`fresh approval may supersede only this App's revocation: ${appId}`, async () => {
    const f = fixture()
    f.responses
      .get(`${root}/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`)
      .check_runs.push({
        name: "Ben approval",
        app: { id: appId },
        status: "completed",
        conclusion: "failure",
      })
    if (appId === 98765) {
      await runGate("publish", f.env, f.request)
      expect(f.writes[0].body.conclusion).toBe("success")
    } else {
      await expect(runGate("publish", f.env, f.request)).rejects.toThrow("pending or unsuccessful")
      expect(f.writes).toEqual([])
    }
  })

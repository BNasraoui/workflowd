import { expect, test } from "bun:test"
import { Octokit } from "@octokit/rest"
import {
  makeOctokitClientPort,
  OctokitInstallationAdapter,
  type OctokitClientPort,
} from "../src/github/adapter"

async function collect<T>(values: AsyncIterable<T>): Promise<ReadonlyArray<T>> {
  const collected: Array<T> = []
  for await (const value of values) collected.push(value)
  return collected
}

test("OctokitInstallationAdapter normalizes authoritative pull request data", async () => {
  const client = {
    getPullRequest: async () => ({
      number: 7,
      user: { login: "author" },
      base: {
        ref: "main",
        sha: "d".repeat(40),
        repo: {
          id: 42,
          full_name: "owner/repo",
          name: "repo",
          owner: { login: "owner" },
        },
      },
      draft: false,
      head: {
        ref: "feature",
        sha: "a".repeat(40),
        repo: { full_name: "owner/repo" },
      },
      state: "open" as const,
      updated_at: "2026-07-19T10:00:00Z",
      mergeable: false,
      mergeable_state: "dirty",
    }),
    listIssueCommentPages: () => (async function* () {})(),
    createIssueComment: async () => 1,
    updateIssueComment: async () => 1,
    listCheckRunPages: () => (async function* () {})(),
    createCheckRun: async () => 1,
    updateCheckRun: async () => 1,
  } satisfies OctokitClientPort
  const adapter = new OctokitInstallationAdapter(client)

  const result = await adapter.getPullRequest({
    owner: "owner",
    repo: "repo",
    pull_number: 7,
  })

  expect(result).toEqual({
    repository: {
      id: 42,
      fullName: "owner/repo",
      name: "repo",
      owner: "owner",
    },
    pullRequest: {
      number: 7,
      author: "author",
      baseRef: "main",
      baseSha: "d".repeat(40),
      draft: false,
      headRef: "feature",
      headRepositoryFullName: "owner/repo",
      headSha: "a".repeat(40),
      state: "open",
      updatedAt: "2026-07-19T10:00:00Z",
    },
    mergeable: false,
    mergeableState: "dirty",
  })
})

test("OctokitInstallationAdapter preserves pages and forwards writes", async () => {
  const writes: Array<{ readonly operation: string; readonly input: object }> = []
  const client = {
    getPullRequest: async () => {
      throw new Error("unused")
    },
    listIssueCommentPages: () =>
      (async function* () {
        yield []
        yield []
      })(),
    createIssueComment: async (input) => {
      writes.push({ operation: "createComment", input })
      return 101
    },
    updateIssueComment: async (input) => {
      writes.push({ operation: "updateComment", input })
      return 102
    },
    listCheckRunPages: () =>
      (async function* () {
        yield []
        yield []
      })(),
    listWorkflowRunPages: () =>
      (async function* () {
        yield [
          {
            id: 301,
            name: "CI",
            headSha: "head",
            conclusion: "failure",
            workflowId: 401,
            path: ".github/workflows/ci.yml",
          },
        ]
      })(),
    listWorkflowJobPages: () =>
      (async function* () {
        yield [{ id: 302, name: "Tests", status: "completed", conclusion: "failure" }]
      })(),
    downloadWorkflowJobLog: async () => "failed log",
    createCheckRun: async (input) => {
      writes.push({ operation: "createCheck", input })
      return 201
    },
    updateCheckRun: async (input) => {
      writes.push({ operation: "updateCheck", input })
      return 202
    },
  } satisfies OctokitClientPort
  const adapter = new OctokitInstallationAdapter(client)

  expect(
    await collect(adapter.listIssueCommentPages({ owner: "owner", repo: "repo", issue_number: 7 })),
  ).toEqual([[], []])
  expect(
    await collect(adapter.listCheckRunPages({ owner: "owner", repo: "repo", ref: "head" })),
  ).toEqual([[], []])
  expect(
    await collect(
      adapter.listWorkflowRunPages({
        owner: "owner",
        repo: "repo",
        head_sha: "head",
        per_page: 20,
      }),
    ),
  ).toEqual([
    [
      {
        id: 301,
        name: "CI",
        headSha: "head",
        conclusion: "failure",
        workflowId: 401,
        path: ".github/workflows/ci.yml",
      },
    ],
  ])
  expect(
    await collect(
      adapter.listWorkflowJobPages({ owner: "owner", repo: "repo", run_id: 301, per_page: 100 }),
    ),
  ).toEqual([[{ id: 302, name: "Tests", status: "completed", conclusion: "failure" }]])
  expect(await adapter.downloadWorkflowJobLog({ owner: "owner", repo: "repo", job_id: 302 })).toBe(
    "failed log",
  )
  const createComment = {
    owner: "owner",
    repo: "repo",
    issue_number: 7,
    body: "created",
  }
  const updateComment = {
    owner: "owner",
    repo: "repo",
    comment_id: 11,
    body: "updated",
  }
  const createCheck = {
    owner: "owner",
    repo: "repo",
    name: "review",
    head_sha: "head",
  }
  const updateCheck = {
    owner: "owner",
    repo: "repo",
    check_run_id: 21,
  }
  expect(await adapter.createIssueComment(createComment)).toBe(101)
  expect(await adapter.updateIssueComment(updateComment)).toBe(102)
  expect(await adapter.createCheckRun(createCheck)).toBe(201)
  expect(await adapter.updateCheckRun(updateCheck)).toBe(202)
  expect(writes).toEqual([
    { operation: "createComment", input: createComment },
    { operation: "updateComment", input: updateComment },
    { operation: "createCheck", input: createCheck },
    { operation: "updateCheck", input: updateCheck },
  ])
})

test("makeOctokitClientPort collects Actions runs, jobs, and failed-job logs", async () => {
  const client = new Octokit({
    request: {
      fetch: async (request: string | URL | Request) => {
        const url =
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.href
              : request.url
        const path = new URL(url).pathname
        const body = path.startsWith("/end-")
          ? []
          : path.endsWith("/actions/runs")
            ? {
                total_count: 1,
                workflow_runs: [
                  {
                    id: 11,
                    name: "CI",
                    workflow_id: 41,
                    path: ".github/workflows/ci.yml",
                    check_suite_id: 51,
                    head_sha: "a".repeat(40),
                    status: "completed",
                    conclusion: "failure",
                  },
                ],
              }
            : path.endsWith("/jobs")
              ? {
                  total_count: 1,
                  jobs: [
                    {
                      id: 12,
                      run_id: 11,
                      run_url: "https://api.github.test/runs/11",
                      node_id: "job-12",
                      head_sha: "a".repeat(40),
                      url: "https://api.github.test/jobs/12",
                      html_url: "https://github.test/jobs/12",
                      status: "completed",
                      conclusion: "failure",
                      created_at: "2026-07-24T00:00:00Z",
                      started_at: "2026-07-24T00:00:01Z",
                      completed_at: "2026-07-24T00:00:02Z",
                      name: "Tests",
                      steps: [],
                      check_run_url: "https://api.github.test/checks/12",
                      labels: ["ubuntu-latest"],
                      runner_id: 1,
                      runner_name: "runner",
                      runner_group_id: 1,
                      runner_group_name: "Default",
                      workflow_name: "CI",
                      head_branch: "feature",
                    },
                  ],
                }
              : "failed assertion"
        const nextPage = path.endsWith("/actions/runs")
          ? "https://api.github.test/end-runs"
          : path.endsWith("/jobs")
            ? "https://api.github.test/end-jobs"
            : undefined
        const response = new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
          headers: {
            "content-type": typeof body === "string" ? "text/plain" : "application/json",
            ...(nextPage === undefined ? {} : { link: `<${nextPage}>; rel="next"` }),
          },
        })
        Object.defineProperty(response, "url", { value: url })
        return response
      },
    },
  })
  const port = makeOctokitClientPort(client)

  const runs = await collect(
    port.listWorkflowRunPages!({
      owner: "owner",
      repo: "repo",
      head_sha: "a".repeat(40),
      per_page: 20,
    }),
  )
  const jobs = await collect(
    port.listWorkflowJobPages!({ owner: "owner", repo: "repo", run_id: 11, per_page: 100 }),
  )
  const log = await port.downloadWorkflowJobLog!({
    owner: "owner",
    repo: "repo",
    job_id: 12,
  })

  expect(runs[0]?.[0]).toMatchObject({
    id: 11,
    name: "CI",
    conclusion: "failure",
    workflowId: 41,
    path: ".github/workflows/ci.yml",
    checkSuiteId: 51,
  })
  expect(jobs[0]?.[0]).toMatchObject({ id: 12, name: "Tests", conclusion: "failure" })
  expect(log).toBe("failed assertion")
})

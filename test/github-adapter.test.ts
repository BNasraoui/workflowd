import { expect, test } from "bun:test"
import {
  makeOctokitClientPort,
  OctokitInstallationAdapter,
  type OctokitClientPort,
} from "../src/github/adapter"
import type { Octokit } from "@octokit/rest"

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
  })
})

test("OctokitInstallationAdapter preserves and normalizes paginated resources", async () => {
  const writes: Array<{ readonly operation: string; readonly input: object }> = []
  const client = {
    getPullRequest: async () => {
      throw new Error("unused")
    },
    listIssueCommentPages: () =>
      (async function* () {
        yield [
          {
            id: 11,
            body: "first",
            user: { type: "Bot" },
            performed_via_github_app: { id: 41 },
          },
        ]
        yield [{ id: 12, user: null }]
      })() as ReturnType<OctokitClientPort["listIssueCommentPages"]>,
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
        yield [{ id: 21, external_id: "review:1", app: { id: 41 } }]
        yield [{ id: 22, external_id: null, app: null }]
      })() as ReturnType<OctokitClientPort["listCheckRunPages"]>,
    createCheckRun: async (input) => {
      writes.push({ operation: "createCheck", input })
      return 201
    },
    updateCheckRun: async (input) => {
      writes.push({ operation: "updateCheck", input })
      return 202
    },
  } as OctokitClientPort
  const adapter = new OctokitInstallationAdapter(client)

  expect(
    await collect(
      adapter.listIssueCommentPages({ owner: "owner", repo: "repo", issue_number: 7 }),
    ),
  ).toEqual([
    [{ id: 11, body: "first", userType: "Bot", appId: 41 }],
    [{ id: 12 }],
  ])
  expect(
    await collect(
      adapter.listCheckRunPages({ owner: "owner", repo: "repo", ref: "head" }),
    ),
  ).toEqual([
    [{ id: 21, externalId: "review:1", appId: 41 }],
    [{ id: 22, externalId: null }],
  ])
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

test("makeOctokitClientPort paginates and maps write response ids", async () => {
  const calls: Array<{ readonly operation: string; readonly input: object }> = []
  const listComments = Symbol("listComments")
  const listForRef = Symbol("listForRef")
  const fake = Object.assign(Object.create(null) as Octokit, {
    paginate: {
      iterator: (endpoint: symbol, input: object) =>
        (async function* () {
          calls.push({ operation: endpoint === listComments ? "comments" : "checks", input })
          yield { data: endpoint === listComments ? [{ id: 1 }] : [{ id: 2 }] }
          yield { data: endpoint === listComments ? [{ id: 3 }] : [{ id: 4 }] }
        })(),
    },
    rest: {
      pulls: { get: async () => ({ data: {} }) },
      issues: {
        listComments,
        createComment: async (input: object) => {
          calls.push({ operation: "createComment", input })
          return { data: { id: 101 } }
        },
        updateComment: async (input: object) => {
          calls.push({ operation: "updateComment", input })
          return { data: { id: 102 } }
        },
      },
      checks: {
        listForRef,
        create: async (input: object) => {
          calls.push({ operation: "createCheck", input })
          return { data: { id: 201 } }
        },
        update: async (input: object) => {
          calls.push({ operation: "updateCheck", input })
          return { data: { id: 202 } }
        },
      },
    },
  })
  const port = makeOctokitClientPort(fake)
  const commentPageInput = { owner: "owner", repo: "repo", issue_number: 7 }
  const checkPageInput = { owner: "owner", repo: "repo", ref: "head" }
  const createCommentInput = { ...commentPageInput, body: "created" }
  const updateCommentInput = { owner: "owner", repo: "repo", comment_id: 9, body: "updated" }
  const createCheckInput = { owner: "owner", repo: "repo", name: "review", head_sha: "head" }
  const updateCheckInput = { owner: "owner", repo: "repo", check_run_id: 10 }

  const commentPages = await collect(port.listIssueCommentPages(commentPageInput))
  const checkPages = await collect(port.listCheckRunPages(checkPageInput))
  expect(commentPages.map((page) => page.map(({ id }) => id))).toEqual([
    [1],
    [3],
  ])
  expect(checkPages.map((page) => page.map(({ id }) => id))).toEqual([
    [2],
    [4],
  ])
  expect(await port.createIssueComment(createCommentInput)).toBe(101)
  expect(await port.updateIssueComment(updateCommentInput)).toBe(102)
  expect(await port.createCheckRun(createCheckInput)).toBe(201)
  expect(await port.updateCheckRun(updateCheckInput)).toBe(202)
  expect(calls).toEqual([
    { operation: "comments", input: commentPageInput },
    { operation: "checks", input: checkPageInput },
    { operation: "createComment", input: createCommentInput },
    { operation: "updateComment", input: updateCommentInput },
    { operation: "createCheck", input: createCheckInput },
    { operation: "updateCheck", input: updateCheckInput },
  ])
})

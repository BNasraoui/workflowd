import { expect, test } from "bun:test"
import { OctokitInstallationAdapter, type OctokitClientPort } from "../src/github/adapter"

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

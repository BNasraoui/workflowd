import { expect, test } from "bun:test"
import { OctokitInstallationAdapter, type OctokitClientPort } from "../src/github/adapter"

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

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { decodeGitHubEvent, InvalidGitHubEvent } from "../src/github-event"

const baseSha = "d".repeat(40)
const headSha = "a".repeat(40)

const pullRequestPayload = {
  action: "opened",
  installation: { id: 91 },
  repository: {
    id: 42,
    full_name: "example-owner/example",
    owner: { login: "example-owner" },
    name: "example",
  },
  pull_request: {
    number: 7,
    draft: false,
    state: "open",
    user: { login: "opencode-agent" },
    head: {
      sha: headSha,
      ref: "opencode/example-job",
      repo: { full_name: "example-owner/example" },
    },
    base: { sha: baseSha, ref: "main" },
  },
}

const issueCommentPayload = {
  action: "created",
  installation: { id: 91 },
  repository: pullRequestPayload.repository,
  issue: {
    number: 7,
    pull_request: { url: "https://api.github.test/pr/7" },
  },
  comment: {
    id: 1001,
    body: "/agent review",
    user: { login: "example-owner" },
  },
}

describe("decodeGitHubEvent", () => {
  test("normalizes an eligible pull request event", async () => {
    const event = await Effect.runPromise(
      decodeGitHubEvent("pull_request", pullRequestPayload),
    )

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      _tag: "PullRequest",
      action: "opened",
      installationId: 91,
      repository: {
        id: 42,
        fullName: "example-owner/example",
        name: "example",
        owner: "example-owner",
      },
      pullRequest: {
        number: 7,
        author: "opencode-agent",
        baseRef: "main",
        baseSha,
        draft: false,
        headRef: "opencode/example-job",
        headRepositoryFullName: "example-owner/example",
        headSha,
        state: "open",
      },
    })
  })

  test("defaults an absent pull request draft flag to false", async () => {
    const { draft: _draft, ...pullRequest } = pullRequestPayload.pull_request
    const event = await Effect.runPromise(
      decodeGitHubEvent("pull_request", {
        ...pullRequestPayload,
        pull_request: pullRequest,
      }),
    )

    expect(event._tag).toBe("PullRequest")
    if (event._tag === "PullRequest") {
      expect(event.pullRequest.draft).toBe(false)
    }
  })

  test.each([
    ["installation ID", { installation: { id: 0 } }],
    ["repository ID", { repository: { ...pullRequestPayload.repository, id: -1 } }],
    [
      "pull request number",
      {
        pull_request: { ...pullRequestPayload.pull_request, number: 0 },
      },
    ],
    [
      "base Git object ID",
      {
        pull_request: {
          ...pullRequestPayload.pull_request,
          base: { ...pullRequestPayload.pull_request.base, sha: "short" },
        },
      },
    ],
    [
      "head Git object ID",
      {
        pull_request: {
          ...pullRequestPayload.pull_request,
          head: { ...pullRequestPayload.pull_request.head, sha: "short" },
        },
      },
    ],
  ])("rejects a malformed %s at ingress", async (_description, override) => {
    const malformed = {
      ...pullRequestPayload,
      ...override,
    }

    const error = await Effect.runPromise(
      Effect.flip(decodeGitHubEvent("pull_request", malformed)),
    )

    expect(error).toBeInstanceOf(InvalidGitHubEvent)
  })

  test.each(["pull_request", "issue_comment"])(
    "deliberately ignores a %s event without an installation",
    async (eventName) => {
      const { installation: _installation, ...payload } =
        eventName === "pull_request"
          ? pullRequestPayload
          : {
              action: "created",
              installation: { id: 91 },
              repository: pullRequestPayload.repository,
              issue: {
                number: 7,
                pull_request: { url: "https://api.github.test/pr/7" },
              },
              comment: {
                id: 1001,
                body: "/agent review",
                user: { login: "example-owner" },
              },
            }

      await expect(
        Effect.runPromise(decodeGitHubEvent(eventName, payload)),
      ).resolves.toEqual({ _tag: "Ignored", reason: "missing-installation" })
    },
  )

  test("normalizes an agent command from a PR conversation comment", async () => {
    const event = await Effect.runPromise(
      decodeGitHubEvent("issue_comment", {
        ...issueCommentPayload,
        comment: {
          ...issueCommentPayload.comment,
          body: "/agent fix",
        },
      }),
    )

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      _tag: "Command",
      action: "created",
      command: "fix",
      commentId: 1001,
      commenter: "example-owner",
      installationId: 91,
      pullRequestNumber: 7,
      repository: {
        id: 42,
        fullName: "example-owner/example",
        name: "example",
        owner: "example-owner",
      },
    })
  })

  test.each([
    [
      "installation ID",
      { ...issueCommentPayload, installation: { id: 0 } },
    ],
    [
      "repository ID",
      {
        ...issueCommentPayload,
        repository: { ...issueCommentPayload.repository, id: -1 },
      },
    ],
    [
      "pull request number",
      { ...issueCommentPayload, issue: { ...issueCommentPayload.issue, number: 0 } },
    ],
    [
      "comment ID",
      {
        ...issueCommentPayload,
        comment: { ...issueCommentPayload.comment, id: 0 },
      },
    ],
    [
      "repository full name",
      {
        ...issueCommentPayload,
        repository: { ...issueCommentPayload.repository, full_name: "" },
      },
    ],
    [
      "repository owner login",
      {
        ...issueCommentPayload,
        repository: {
          ...issueCommentPayload.repository,
          owner: { login: "" },
        },
      },
    ],
    [
      "commenter login",
      {
        ...issueCommentPayload,
        comment: {
          ...issueCommentPayload.comment,
          user: { login: "" },
        },
      },
    ],
    [
      "comment body",
      {
        ...issueCommentPayload,
        comment: { ...issueCommentPayload.comment, body: "" },
      },
    ],
  ])("rejects a malformed command %s at ingress", async (_description, malformed) => {
    const error = await Effect.runPromise(
      Effect.flip(decodeGitHubEvent("issue_comment", malformed)),
    )

    expect(error).toBeInstanceOf(InvalidGitHubEvent)
  })
})

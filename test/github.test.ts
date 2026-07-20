import { describe, expect, test } from "bun:test"
import type { RestEndpointMethodTypes } from "@octokit/rest"
import { Effect, Schema } from "effect"
import {
  Publication,
  type Publication as PublicationType,
} from "../src/domain/publication"
import {
  GitHubAppAdapter,
  GitHubClientError,
  type GitHubPort,
} from "../src/github"
import type {
  GitHubCheckRun,
  GitHubInstallationAdapter,
  GitHubIssueComment,
  GitHubPullRequestData,
} from "../src/github/adapter"

const headSha = "a".repeat(40)
const alwaysCurrent = () => Effect.succeed(true)

function makePublication(summary = "No actionable findings."): PublicationType {
  return Schema.decodeUnknownSync(Publication)({
    id: 1,
    operationKey: "review:42:7:1",
    installationId: 91,
    repositoryId: 42,
    repositoryFullName: "example-owner/example",
    pullRequestNumber: 7,
    target: {
      baseSha: "d".repeat(40),
      baseRef: "main",
      headSha,
      headRef: "opencode/example-job",
      headRepositoryFullName: "example-owner/example",
    },
    generation: 1,
    reviewRequestNumber: 1,
    attempt: 1,
    review: {
      verdict: "pass",
      summary,
      findings: [],
    },
  })
}

function makePullRequestData(): GitHubPullRequestData {
  return {
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
      baseSha: "d".repeat(40),
      draft: false,
      headRef: "opencode/example-job",
      headRepositoryFullName: "example-owner/example",
      headSha,
      state: "open",
      updatedAt: "2026-07-19T10:00:00Z",
    },
  }
}

async function* pages<A>(
  values: ReadonlyArray<ReadonlyArray<A>>,
  onPage: (page: number) => void,
): AsyncIterable<ReadonlyArray<A>> {
  for (let index = 0; index < values.length; index += 1) {
    onPage(index + 1)
    yield values[index]!
  }
}

function makeRecordingClient(options?: {
  readonly pullRequest?: GitHubPullRequestData
  readonly commentPages?: ReadonlyArray<ReadonlyArray<GitHubIssueComment>>
  readonly checkRunPages?: ReadonlyArray<ReadonlyArray<GitHubCheckRun>>
}) {
  const calls: Array<{ readonly method: string; readonly input: object }> = []
  const record = (method: string, input: object) => {
    calls.push({ method, input })
  }
  const adapter: GitHubInstallationAdapter = {
    getPullRequest: async (input) => {
      record("pulls.get", input)
      return options?.pullRequest ?? makePullRequestData()
    },
    listIssueCommentPages: (input) =>
      pages(options?.commentPages ?? [[]], (page) =>
        record("issues.listComments", { ...input, page }),
      ),
    createIssueComment: async (input) => {
      record("issues.createComment", input)
      return 22
    },
    updateIssueComment: async (input) => {
      record("issues.updateComment", input)
      return 22
    },
    listCheckRunPages: (input) =>
      pages(options?.checkRunPages ?? [[]], (page) =>
        record("checks.listForRef", { ...input, page }),
      ),
    createCheckRun: async (input) => {
      record("checks.create", input)
      return 33
    },
    updateCheckRun: async (input) => {
      record("checks.update", input)
      return 33
    },
  }

  return {
    adapter,
    calls,
    getClient: async () => adapter,
  }
}

function callInput<T extends object>(
  calls: ReadonlyArray<{ readonly method: string; readonly input: object }>,
  method: string,
): T {
  const input = calls.find((call) => call.method === method)?.input
  if (input === undefined) throw new Error(`Missing input for ${method}`)
  return input as T
}

describe("GitHubAppAdapter.publishReview", () => {
  test("creates the sticky comment and per-SHA Check Run with valid abortable payloads", async () => {
    const recording = makeRecordingClient()
    const currentnessTimes: Array<Date> = []
    const client: GitHubPort = new GitHubAppAdapter(
      12_345,
      recording.getClient,
    )
    const publication: PublicationType = {
      ...makePublication(),
      review: {
        verdict: "changes_requested",
        summary: "One correctness issue needs attention.",
        findings: [
          {
            severity: "high",
            title: "Retries duplicate the charge",
            body: "Add an idempotency key before retrying the provider call.",
            path: "src/payments.ts",
            line: 81,
          },
        ],
      },
    }

    const result = await Effect.runPromise(
      client.publishReview(publication, (now) =>
        Effect.sync(() => {
          currentnessTimes.push(now)
          return true
        }),
      ),
    )

    expect(result).toBe("published")
    expect(currentnessTimes).toHaveLength(2)
    expect(currentnessTimes.every((now) => now instanceof Date)).toBe(true)
    expect(recording.calls.map((call) => call.method)).toEqual([
      "pulls.get",
      "issues.listComments",
      "issues.createComment",
      "checks.listForRef",
      "checks.create",
    ])
    expect(callInput(recording.calls, "checks.listForRef")).toMatchObject({
      app_id: 12_345,
    })
    expect(callInput(recording.calls, "checks.create")).toMatchObject({
      conclusion: "action_required",
      external_id: "review:42:7:1",
      head_sha: headSha,
    })
    const comment = callInput<
      RestEndpointMethodTypes["issues"]["createComment"]["parameters"]
    >(recording.calls, "issues.createComment")
    expect(comment.body).toContain("<!-- workflowd:review:42:7 -->")
    expect(comment.body).toContain(`Commit: \`${headSha}\``)
    expect(comment.body).toContain("**[HIGH] Retries duplicate the charge**")
    expect(comment.body).toContain("`src/payments.ts:81`")
    for (const call of recording.calls) {
      expect(call.input).toMatchObject({
        request: { signal: expect.any(AbortSignal) },
      })
    }
  })

  test.each([
    ["base SHA", { baseSha: "e".repeat(40) }],
    ["base ref", { baseRef: "release" }],
    ["head ref", { headRef: "renamed-feature" }],
    ["head repository", { headRepositoryFullName: "fork/example" }],
  ])(
    "suppresses publication when the head SHA matches but the %s changed",
    async (_description, changedTarget) => {
      const pullRequest = makePullRequestData()
      const recording = makeRecordingClient({
        pullRequest: {
          ...pullRequest,
          pullRequest: { ...pullRequest.pullRequest, ...changedTarget },
        },
      })
      const client = new GitHubAppAdapter(12_345, recording.getClient)

      const result = await Effect.runPromise(
        client.publishReview(makePublication(), alwaysCurrent),
      )

      expect(result).toBe("stale")
      expect(recording.calls.map((call) => call.method)).toEqual(["pulls.get"])
    },
  )

  test.each([
    ["closed", { state: "closed" as const }],
    ["draft", { draft: true }],
  ])(
    "suppresses all writes when the fresh pull request is %s",
    async (_description, ineligible) => {
      const pullRequest = makePullRequestData()
      const recording = makeRecordingClient({
        pullRequest: {
          ...pullRequest,
          pullRequest: { ...pullRequest.pullRequest, ...ineligible },
        },
      })
      const client = new GitHubAppAdapter(12_345, recording.getClient)

      const result = await Effect.runPromise(
        client.publishReview(makePublication(), alwaysCurrent),
      )

      expect(result).toBe("stale")
      expect(recording.calls.map((call) => call.method)).toEqual(["pulls.get"])
    },
  )

  test("suppresses all writes when superseded after claim and before the comment mutation", async () => {
    const recording = makeRecordingClient()
    const client = new GitHubAppAdapter(12_345, recording.getClient)

    const result = await Effect.runPromise(
      client.publishReview(makePublication(), () => Effect.succeed(false)),
    )

    expect(result).toBe("stale")
    expect(recording.calls.map((call) => call.method)).toEqual([
      "pulls.get",
      "issues.listComments",
    ])
  })

  test("suppresses a stale check after the comment and lets the latest publication reassert owned output", async () => {
    const comments: Array<GitHubIssueComment> = []
    const checks: Array<GitHubCheckRun> = []
    const writes: Array<string> = []
    const adapter: GitHubInstallationAdapter = {
      getPullRequest: async () => makePullRequestData(),
      listIssueCommentPages: () => pages([comments], () => undefined),
      createIssueComment: async (input) => {
        comments.push({
          id: 22,
          body: input.body,
          userType: "Bot",
          appId: 12_345,
        })
        writes.push("comment:create")
        return 22
      },
      updateIssueComment: async (input) => {
        comments[0] = {
          id: input.comment_id,
          body: input.body,
          userType: "Bot",
          appId: 12_345,
        }
        writes.push("comment:update")
        return input.comment_id
      },
      listCheckRunPages: () => pages([checks], () => undefined),
      createCheckRun: async (input) => {
        checks.push({
          id: 33,
          ...(input.external_id === undefined || input.external_id === null
            ? {}
            : { externalId: input.external_id }),
          appId: 12_345,
        })
        writes.push("check:create")
        return 33
      },
      updateCheckRun: async (input) => {
        writes.push("check:update")
        return input.check_run_id
      },
    }
    const client = new GitHubAppAdapter(12_345, async () => adapter)
    let oldGuardCalls = 0

    const oldResult = await Effect.runPromise(
      client.publishReview(makePublication("Old review."), () =>
        Effect.sync(() => ++oldGuardCalls === 1),
      ),
    )
    const latest = Schema.decodeUnknownSync(Publication)({
      ...makePublication("Latest review."),
      operationKey: "review:42:7:1:2",
      reviewRequestNumber: 2,
    })
    const latestResult = await Effect.runPromise(
      client.publishReview(latest, alwaysCurrent),
    )

    expect(oldResult).toBe("stale")
    expect(latestResult).toBe("published")
    expect(writes).toEqual(["comment:create", "comment:update", "check:create"])
    expect(comments[0]?.body).toContain("Latest review.")
    expect(checks[0]?.externalId).toBe("review:42:7:1:2")
  })

  test("ignores matching sticky comments and Check Runs owned by another app", async () => {
    const marker = "<!-- workflowd:review:42:7 -->"
    const recording = makeRecordingClient({
      commentPages: [
        [
          {
            id: 99,
            body: marker,
            userType: "Bot",
            appId: 999,
          },
        ],
      ],
      checkRunPages: [
        [{ id: 100, externalId: "review:42:7:1", appId: 999 }],
      ],
    })
    const client = new GitHubAppAdapter(12_345, recording.getClient)

    await Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent))

    expect(recording.calls.map((call) => call.method)).toContain(
      "issues.createComment",
    )
    expect(recording.calls.map((call) => call.method)).not.toContain(
      "issues.updateComment",
    )
    expect(recording.calls.map((call) => call.method)).toContain(
      "checks.create",
    )
    expect(recording.calls.map((call) => call.method)).not.toContain(
      "checks.update",
    )
  })

  test("stops each page iterator as soon as an owned result is found", async () => {
    const marker = "<!-- workflowd:review:42:7 -->"
    const recording = makeRecordingClient({
      commentPages: [
        [{ id: 1, body: marker, userType: "Bot", appId: 999 }],
        [{ id: 2, body: marker, userType: "Bot", appId: 12_345 }],
        [{ id: 3, body: marker, userType: "Bot", appId: 12_345 }],
      ],
      checkRunPages: [
        [{ id: 4, externalId: "other", appId: 12_345 }],
        [{ id: 5, externalId: "review:42:7:1", appId: 12_345 }],
        [{ id: 6, externalId: "review:42:7:1", appId: 12_345 }],
      ],
    })
    const client = new GitHubAppAdapter(12_345, recording.getClient)

    await Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent))

    expect(
      recording.calls.filter((call) => call.method === "issues.listComments"),
    ).toHaveLength(2)
    expect(
      recording.calls.filter((call) => call.method === "checks.listForRef"),
    ).toHaveLength(2)
    expect(callInput(recording.calls, "issues.updateComment")).toMatchObject({
      comment_id: 2,
    })
    expect(callInput(recording.calls, "checks.update")).toMatchObject({
      check_run_id: 5,
    })
  })

  test("reuses a published comment when retrying after Check Run failure", async () => {
    const comments: Array<GitHubIssueComment> = []
    let commentCreates = 0
    let commentUpdates = 0
    let checkCreates = 0
    const adapter: GitHubInstallationAdapter = {
      getPullRequest: async () => makePullRequestData(),
      listIssueCommentPages: () => pages([comments], () => undefined),
      createIssueComment: async (input) => {
        commentCreates += 1
        comments.push({
          id: 22,
          body: input.body,
          userType: "Bot",
          appId: 12_345,
        })
        return 22
      },
      updateIssueComment: async () => {
        commentUpdates += 1
        return 22
      },
      listCheckRunPages: () => pages([[]], () => undefined),
      createCheckRun: async () => {
        checkCreates += 1
        if (checkCreates === 1) throw new Error("temporary checks failure")
        return 33
      },
      updateCheckRun: async () => 33,
    }
    const client = new GitHubAppAdapter(12_345, async () => adapter)

    const failure = await Effect.runPromise(
      Effect.flip(client.publishReview(makePublication(), alwaysCurrent)),
    )
    expect(failure).toBeInstanceOf(GitHubClientError)
    await expect(
      Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent)),
    ).resolves.toBe("published")

    expect(commentCreates).toBe(1)
    expect(commentUpdates).toBe(1)
    expect(checkCreates).toBe(2)
  })

  test("bounds oversized Check Run output while preserving review metadata", async () => {
    const recording = makeRecordingClient()
    const client = new GitHubAppAdapter(12_345, recording.getClient)

    const publication = Schema.decodeUnknownSync(Publication)({
      ...makePublication(),
      review: {
        verdict: "changes_requested",
        summary: "Large valid review.",
        findings: Array.from({ length: 50 }, (_, index) => ({
          severity: "high",
          title: `Finding ${index + 1}`,
          body: "x".repeat(10_000),
        })),
      },
    })
    await Effect.runPromise(client.publishReview(publication, alwaysCurrent))

    const input = callInput<
      RestEndpointMethodTypes["checks"]["create"]["parameters"]
    >(recording.calls, "checks.create")
    expect(input.output?.summary).toBeString()
    expect(input.output?.text).toBeString()
    expect(input.output!.summary.length).toBeLessThanOrEqual(65_535)
    expect(input.output!.text!.length).toBeLessThanOrEqual(65_535)
    expect(input.output?.text).toContain(
      "<!-- workflowd:review:42:7 -->",
    )
    expect(input.output?.text).toContain(`Commit: \`${headSha}\``)
  })
})

describe("GitHubAppAdapter.fetchPullRequestSnapshot", () => {
  test("returns the authoritative normalized pull request shape", async () => {
    const recording = makeRecordingClient()
    const client = new GitHubAppAdapter(12_345, recording.getClient)

    const snapshot = await Effect.runPromise(
      client.fetchPullRequestSnapshot({
        installationId: 91,
        repositoryFullName: "example-owner/example",
        pullRequestNumber: 7,
      }),
    )

    expect(snapshot).toEqual({
      _tag: "AuthoritativePullRequestSnapshot",
      installationId: 91,
      ...makePullRequestData(),
    })
    expect(callInput(recording.calls, "pulls.get")).toMatchObject({
      owner: "example-owner",
      repo: "example",
      pull_number: 7,
      request: { signal: expect.any(AbortSignal) },
    })
  })
})

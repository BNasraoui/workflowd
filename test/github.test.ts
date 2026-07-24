import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { SessionReference } from "../src/agent-harness"
import { Publication, type Publication as PublicationType } from "../src/domain/publication"
import { GitHubAppAdapter, GitHubClientError, type GitHubPort } from "../src/github"
import type {
  GitHubCheckRun,
  GitHubInstallationAdapter,
  GitHubIssueComment,
  GitHubPullRequestData,
} from "../src/github/adapter"
import type { SonarRequest } from "../src/github/head-evidence"

const headSha = "a".repeat(40)
const alwaysCurrent = () => Effect.succeed(true)
const sessionReference: SessionReference = {
  sessionReferenceId: "session-reference-1",
  serverId: "opencode-primary",
  endpointAlias: "private-opencode",
  directory: "/worktrees/review-1",
  nativeSessionId: "ses_exact",
  scope: { _tag: "GenerationScope", workflowId: "pr:42:7", generation: 1 },
  operationId: "review:42:7:1",
  operationRevision: 1,
  attempt: 1,
  leaseToken: "lease-token-123456",
  createdAt: "2026-07-21T12:00:00.000Z",
  state: "succeeded",
}

const passingSonar: SonarRequest = async (path) => {
  if (path.startsWith("/api/project_pull_requests/list")) {
    return { status: 200, body: { pullRequests: [{ key: "7", commit: { sha: headSha } }] } }
  }
  if (path.startsWith("/api/issues/search")) {
    return { status: 200, body: { paging: { total: 0 }, issues: [] } }
  }
  return {
    status: 200,
    body: {
      component: {
        measures: [{ metric: "new_duplicated_lines_density", periods: [{ value: "0" }] }],
      },
    },
  }
}

class TestGitHubAppAdapter extends GitHubAppAdapter {
  constructor(
    appId: number,
    getClient: ConstructorParameters<typeof GitHubAppAdapter>[1],
    sessionAccess?: ConstructorParameters<typeof GitHubAppAdapter>[2],
  ) {
    super(appId, getClient, sessionAccess, passingSonar)
  }
}

type RecordingInputs = {
  readonly "pulls.get": Parameters<GitHubInstallationAdapter["getPullRequest"]>[0]
  readonly "issues.listComments": Parameters<GitHubInstallationAdapter["listIssueCommentPages"]>[0]
  readonly "issues.createComment": Parameters<GitHubInstallationAdapter["createIssueComment"]>[0]
  readonly "issues.updateComment": Parameters<GitHubInstallationAdapter["updateIssueComment"]>[0]
  readonly "checks.listForRef": Parameters<GitHubInstallationAdapter["listCheckRunPages"]>[0]
  readonly "checks.create": Parameters<GitHubInstallationAdapter["createCheckRun"]>[0]
  readonly "checks.update": Parameters<GitHubInstallationAdapter["updateCheckRun"]>[0]
}

type RecordingCall = {
  readonly [Method in keyof RecordingInputs]: {
    readonly method: Method
    readonly input: RecordingInputs[Method]
  }
}[keyof RecordingInputs]

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
    mergeable: true,
    mergeableState: "clean",
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
  const calls: Array<RecordingCall> = []
  const record = (call: RecordingCall) => {
    calls.push(call)
  }
  const adapter: GitHubInstallationAdapter = {
    getPullRequest: async (input) => {
      record({ method: "pulls.get", input })
      return options?.pullRequest ?? makePullRequestData()
    },
    listIssueCommentPages: (input) =>
      pages(options?.commentPages ?? [[]], (page) =>
        record({ method: "issues.listComments", input: { ...input, page } }),
      ),
    createIssueComment: async (input) => {
      record({ method: "issues.createComment", input })
      return 22
    },
    updateIssueComment: async (input) => {
      record({ method: "issues.updateComment", input })
      return 22
    },
    listCheckRunPages: (input) =>
      pages(options?.checkRunPages ?? [[]], (page) =>
        record({ method: "checks.listForRef", input: { ...input, page } }),
      ),
    createCheckRun: async (input) => {
      record({ method: "checks.create", input })
      return 33
    },
    updateCheckRun: async (input) => {
      record({ method: "checks.update", input })
      return 33
    },
  }

  return {
    adapter,
    calls,
    getClient: async () => adapter,
  }
}

function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: "pulls.get",
): RecordingInputs["pulls.get"]
function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: "issues.listComments",
): RecordingInputs["issues.listComments"]
function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: "issues.createComment",
): RecordingInputs["issues.createComment"]
function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: "issues.updateComment",
): RecordingInputs["issues.updateComment"]
function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: "checks.listForRef",
): RecordingInputs["checks.listForRef"]
function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: "checks.create",
): RecordingInputs["checks.create"]
function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: "checks.update",
): RecordingInputs["checks.update"]
function callInput(
  calls: ReadonlyArray<RecordingCall>,
  method: RecordingCall["method"],
): RecordingInputs[keyof RecordingInputs] {
  const call = calls.find((candidate) => candidate.method === method)
  if (call === undefined) throw new Error(`Missing input for ${method}`)
  return call.input
}

describe("GitHubAppAdapter.publishReview", () => {
  test("publishes the exact resumable session command for the review result", async () => {
    const recording = makeRecordingClient()
    const publication = Schema.decodeUnknownSync(Publication)({
      ...makePublication(),
      sessionReferenceId: sessionReference.sessionReferenceId,
      sessionReference,
      sessionExecutionState: "succeeded",
    })
    const client = new TestGitHubAppAdapter(12_345, recording.getClient, {
      resolve: () =>
        Effect.succeed({
          _tag: "Available" as const,
          sessionReferenceId: sessionReference.sessionReferenceId,
          command:
            "opencode attach 'https://mint.tailnet.example:4096' --dir '/worktrees/review-1' --session 'ses_exact'",
        }),
    })

    await Effect.runPromise(client.publishReview(publication, alwaysCurrent))

    const comment = callInput(recording.calls, "issues.createComment")
    expect(comment.body).toContain("### Resume agent session")
    expect(comment.body).toContain("opencode attach")
    expect(comment.body).toContain("--session 'ses_exact'")
  })

  test("publishes an explicit missing-session result without substituting another session", async () => {
    const recording = makeRecordingClient()
    const publication = Schema.decodeUnknownSync(Publication)({
      ...makePublication(),
      sessionReferenceId: sessionReference.sessionReferenceId,
      sessionReference,
      sessionExecutionState: "succeeded",
    })
    const client = new TestGitHubAppAdapter(12_345, recording.getClient, {
      resolve: () =>
        Effect.succeed({
          _tag: "Unavailable" as const,
          sessionReferenceId: sessionReference.sessionReferenceId,
          reason: "missing" as const,
        }),
    })

    await Effect.runPromise(client.publishReview(publication, alwaysCurrent))

    const comment = callInput(recording.calls, "issues.createComment")
    expect(comment.body).toContain("Session unavailable: `missing`")
    expect(comment.body).toContain("`session-reference-1`")
    expect(comment.body).not.toContain("--continue")
  })

  test("does not resolve a session attributed to another workflow", async () => {
    const recording = makeRecordingClient()
    const publication = Schema.decodeUnknownSync(Publication)({
      ...makePublication(),
      sessionReferenceId: sessionReference.sessionReferenceId,
      sessionReference: {
        ...sessionReference,
        scope: { ...sessionReference.scope, workflowId: "pr:999:7" },
      },
      sessionExecutionState: "succeeded",
    })
    let resolved = false
    const client = new TestGitHubAppAdapter(12_345, recording.getClient, {
      resolve: () => {
        resolved = true
        return Effect.die("must not resolve a foreign workflow")
      },
    })

    await Effect.runPromise(client.publishReview(publication, alwaysCurrent))

    expect(resolved).toBe(false)
    expect(callInput(recording.calls, "issues.createComment").body).toContain(
      "Session unavailable: `superseded`",
    )
  })

  test("preserves the resume command when review content reaches GitHub limits", async () => {
    const recording = makeRecordingClient()
    const publication = Schema.decodeUnknownSync(Publication)({
      ...makePublication(),
      review: {
        verdict: "changes_requested",
        summary: "Large review",
        findings: Array.from({ length: 7 }, (_, index) => ({
          severity: "high",
          title: `Finding ${index}`,
          body: "x".repeat(10_000),
        })),
      },
      sessionReferenceId: sessionReference.sessionReferenceId,
      sessionReference,
      sessionExecutionState: "succeeded",
    })
    const client = new TestGitHubAppAdapter(12_345, recording.getClient, {
      resolve: () =>
        Effect.succeed({
          _tag: "Available" as const,
          sessionReferenceId: sessionReference.sessionReferenceId,
          command: "opencode attach 'https://mint' --dir '/worktree' --session 'ses_exact'",
        }),
    })

    await Effect.runPromise(client.publishReview(publication, alwaysCurrent))

    expect(callInput(recording.calls, "issues.createComment").body).toContain(
      "--session 'ses_exact'",
    )
  })

  test("creates the sticky comment and per-SHA Check Run with valid abortable payloads", async () => {
    const recording = makeRecordingClient()
    const currentnessTimes: Array<Date> = []
    const client: GitHubPort = new TestGitHubAppAdapter(12_345, recording.getClient)
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
      "pulls.get",
      "checks.listForRef",
      "pulls.get",
      "issues.listComments",
      "issues.createComment",
      "checks.listForRef",
      "checks.create",
    ])
    expect(
      recording.calls.some(
        (call) => call.method === "checks.listForRef" && call.input.app_id === 12_345,
      ),
    ).toBe(true)
    expect(callInput(recording.calls, "checks.create")).toMatchObject({
      conclusion: "action_required",
      external_id: "review:42:7:1",
      head_sha: headSha,
    })
    const comment = callInput(recording.calls, "issues.createComment")
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
      const client = new TestGitHubAppAdapter(12_345, recording.getClient)

      const result = await Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent))

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
      const client = new TestGitHubAppAdapter(12_345, recording.getClient)

      const result = await Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent))

      expect(result).toBe("stale")
      expect(recording.calls.map((call) => call.method)).toEqual(["pulls.get"])
    },
  )

  test("suppresses all writes when superseded after claim and before the comment mutation", async () => {
    const recording = makeRecordingClient()
    const client = new TestGitHubAppAdapter(12_345, recording.getClient)

    const result = await Effect.runPromise(
      client.publishReview(makePublication(), () => Effect.succeed(false)),
    )

    expect(result).toBe("stale")
    expect(recording.calls.map((call) => call.method)).toEqual([
      "pulls.get",
      "pulls.get",
      "checks.listForRef",
      "pulls.get",
      "issues.listComments",
    ])
  })

  test("suppresses a stale check after the comment and lets the latest publication reassert owned output", async () => {
    const comments: Array<GitHubIssueComment> = []
    const checks: Array<GitHubCheckRun> = [
      { id: 20, name: "Required checks", status: "completed", conclusion: "success" },
    ]
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
    const client = new TestGitHubAppAdapter(12_345, async () => adapter)
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
    const latestResult = await Effect.runPromise(client.publishReview(latest, alwaysCurrent))

    expect(oldResult).toBe("stale")
    expect(latestResult).toBe("published")
    expect(writes).toEqual(["comment:create", "comment:update", "check:create"])
    expect(comments[0]?.body).toContain("Latest review.")
    expect(checks.at(-1)?.externalId).toBe("review:42:7:1:2")
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
      checkRunPages: [[{ id: 100, externalId: "review:42:7:1", appId: 999 }]],
    })
    const client = new TestGitHubAppAdapter(12_345, recording.getClient)

    await Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent))

    expect(recording.calls.map((call) => call.method)).toContain("issues.createComment")
    expect(recording.calls.map((call) => call.method)).not.toContain("issues.updateComment")
    expect(recording.calls.map((call) => call.method)).toContain("checks.create")
    expect(recording.calls.map((call) => call.method)).not.toContain("checks.update")
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
    const client = new TestGitHubAppAdapter(12_345, recording.getClient)

    await Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent))

    expect(recording.calls.filter((call) => call.method === "issues.listComments")).toHaveLength(2)
    expect(recording.calls.filter((call) => call.method === "checks.listForRef")).toHaveLength(5)
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
    const client = new TestGitHubAppAdapter(12_345, async () => adapter)

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
    const client = new TestGitHubAppAdapter(12_345, recording.getClient)

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

    const input = callInput(recording.calls, "checks.create")
    expect(input.output?.summary).toBeString()
    expect(input.output?.text).toBeString()
    expect(input.output!.summary.length).toBeLessThanOrEqual(65_535)
    expect(input.output!.text!.length).toBeLessThanOrEqual(65_535)
    expect(input.output?.text).toContain("<!-- workflowd:review:42:7 -->")
    expect(input.output?.text).toContain(`Commit: \`${headSha}\``)
  })

  test("reuses the exact-target publication gate to block a confirmed merge conflict", async () => {
    const pullRequest = makePullRequestData()
    const recording = makeRecordingClient({
      pullRequest: { ...pullRequest, mergeable: false, mergeableState: "dirty" },
    })
    const client = new TestGitHubAppAdapter(12_345, recording.getClient)

    await Effect.runPromise(client.publishReview(makePublication(), alwaysCurrent))

    const comment = callInput(recording.calls, "issues.createComment")
    expect(comment.body).toContain("Verdict: **Changes requested**")
    expect(comment.body).toContain("Pull request has merge conflicts")
    expect(callInput(recording.calls, "checks.create")).toMatchObject({
      conclusion: "action_required",
      head_sha: headSha,
    })
  })

  test("publishes no pass while exact-target mergeability is pending", async () => {
    const pullRequest = makePullRequestData()
    const recording = makeRecordingClient({
      pullRequest: { ...pullRequest, mergeable: null, mergeableState: "unknown" },
    })
    const client = new TestGitHubAppAdapter(12_345, recording.getClient)

    const error = await Effect.runPromise(
      Effect.flip(client.publishReview(makePublication(), alwaysCurrent)),
    )

    expect(error).toBeInstanceOf(GitHubClientError)
    expect(recording.calls.map((call) => call.method)).not.toContain("issues.createComment")
    expect(recording.calls.map((call) => call.method)).not.toContain("checks.create")
  })
})

describe("GitHubAppAdapter.fetchPullRequestSnapshot", () => {
  test("returns the authoritative normalized pull request shape", async () => {
    const recording = makeRecordingClient()
    const client = new TestGitHubAppAdapter(12_345, recording.getClient)

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

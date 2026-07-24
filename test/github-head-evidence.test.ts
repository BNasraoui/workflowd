import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { collectHeadEvidence } from "../src/github/head-evidence"
import type { GitHubInstallationAdapter } from "../src/github/adapter"

const headSha = "a".repeat(40)
const workflowdAppId = 10
const target = {
  baseRef: "main",
  baseSha: "b".repeat(40),
  headRef: "feature",
  headRepositoryFullName: "owner/repo",
  headSha,
}

function pull(head = headSha) {
  return {
    repository: { id: 1, fullName: "owner/repo", name: "repo", owner: "owner" },
    pullRequest: {
      number: 7,
      author: "author",
      baseRef: "main",
      baseSha: "b".repeat(40),
      draft: false,
      headRef: "feature",
      headRepositoryFullName: "owner/repo",
      headSha: head,
      state: "open" as const,
    },
    mergeable: true,
    mergeableState: "clean",
  }
}

async function* onePage<A>(items: ReadonlyArray<A>) {
  yield items
}

const requiredCheckRuns = [
  {
    id: 101,
    name: "Required checks",
    status: "completed",
    conclusion: "success",
    appId: 20,
    appSlug: "github-actions",
  },
  {
    id: 102,
    name: "SonarCloud Code Analysis",
    status: "completed",
    conclusion: "success",
    appId: 21,
    appSlug: "sonarcloud",
  },
  {
    id: 103,
    name: "CodeQL (JavaScript/TypeScript)",
    status: "completed",
    conclusion: "success",
    appId: 22,
    appSlug: "github-actions",
  },
]

function github(overrides: Partial<GitHubInstallationAdapter> = {}): GitHubInstallationAdapter {
  return {
    getPullRequest: async () => pull(),
    listIssueCommentPages: () => onePage([]),
    createIssueComment: async () => 1,
    updateIssueComment: async () => 1,
    listCheckRunPages: () => onePage(requiredCheckRuns),
    listWorkflowRunPages: () => onePage([]),
    listWorkflowJobPages: () => onePage([]),
    downloadWorkflowJobLog: async () => "",
    createCheckRun: async () => 1,
    updateCheckRun: async () => 1,
    ...overrides,
  }
}

function sonar(options?: {
  head?: string
  issues?: number
  duplication?: string
  prPresent?: boolean
}) {
  return async (path: string) => {
    if (path.startsWith("/api/project_pull_requests/list")) {
      return {
        status: 200,
        body: {
          pullRequests:
            options?.prPresent === false
              ? []
              : [{ key: "7", commit: { sha: options?.head ?? headSha } }],
        },
      }
    }
    if (path.startsWith("/api/issues/search")) {
      return {
        status: 200,
        body: {
          paging: { total: options?.issues ?? 0 },
          issues:
            options?.issues === 1
              ? [
                  {
                    severity: "MAJOR",
                    message: "Do not use this value.",
                    component: "owner_repo:src/a.ts",
                    line: 4,
                  },
                ]
              : [],
        },
      }
    }
    return {
      status: 200,
      body: {
        component: {
          measures: [
            {
              metric: "new_duplicated_lines_density",
              periods: [{ value: options?.duplication ?? "0.5" }],
            },
          ],
        },
      },
    }
  }
}

describe("collectHeadEvidence", () => {
  test("collects exact-head checks and public Sonar findings independently of check success", async () => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () =>
            onePage([
              ...requiredCheckRuns,
              {
                id: 2,
                name: "SonarCloud Code Analysis",
                status: "completed",
                conclusion: "success",
              },
            ]),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar({ issues: 1 }),
      }),
    )

    expect(evidence.headSha).toBe(headSha)
    expect(
      evidence.ci.checks.some(
        (check) => check.name === "SonarCloud Code Analysis" && check.state === "success",
      ),
    ).toBe(true)
    expect(evidence.sonar).toMatchObject({ state: "fail", unresolvedIssueCount: 1 })
  })

  test.each([
    ["missing", sonar({ prPresent: false })],
    ["stale", sonar({ head: "c".repeat(40) })],
  ] as const)("fails closed for %s Sonar evidence", async (state, sonarRequest) => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github(),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest,
      }),
    )

    expect(evidence.sonar.state).toBe(state)
  })

  test("marks evidence stale when the pull request moves during collection", async () => {
    let reads = 0
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          getPullRequest: async () => pull(++reads === 1 ? headSha : "d".repeat(40)),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )

    expect(evidence.ci.state).toBe("stale")
    expect(evidence.sonar.state).toBe("stale")
  })

  test("marks evidence stale when the exact target base moves during collection", async () => {
    let reads = 0
    const input = {
      client: github({
        getPullRequest: async () => ({
          ...pull(),
          pullRequest: {
            ...pull().pullRequest,
            baseSha: ++reads === 1 ? "b".repeat(40) : "c".repeat(40),
          },
        }),
      }),
      repository: { owner: "owner", repo: "repo" },
      pullRequestNumber: 7,
      target,
      workflowdAppId,
      sonarRequest: sonar(),
    }

    const evidence = await Effect.runPromise(collectHeadEvidence(input))

    expect(evidence.ci.state).toBe("stale")
    expect(evidence.mergeability.state).toBe("unavailable")
  })

  test("includes bounded sanitized failed Actions logs and excludes Workflowd's checks", async () => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () =>
            onePage([
              ...requiredCheckRuns,
              {
                id: 1,
                name: "OpenCode Review",
                status: "in_progress",
                appId: workflowdAppId,
                externalId: "review:1",
              },
              {
                id: 2,
                name: "Workflowd PR Gate",
                status: "completed",
                conclusion: "failure",
                appId: workflowdAppId,
                externalId: "gate:1",
              },
              { id: 3, name: "Tests", status: "completed", conclusion: "failure" },
            ]),
          listWorkflowRunPages: () =>
            onePage([{ id: 91, name: "CI", headSha, status: "completed", conclusion: "failure" }]),
          listWorkflowJobPages: () =>
            onePage([{ id: 92, name: "Tests", status: "completed", conclusion: "failure" }]),
          downloadWorkflowJobLog: async () =>
            "\u001b[31mfailed\u001b[0m\nAuthorization: Bearer secret\n" + "x".repeat(20_000),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )

    const tests = evidence.ci.checks.find((check) => check.name === "Tests")
    expect(evidence.ci.checks.map((check) => check.name)).not.toContain("OpenCode Review")
    expect(tests?.log?.length).toBeLessThanOrEqual(8_000)
    expect(tests?.log).not.toContain("secret")
    expect(tests?.log).not.toContain("\u001b")
    expect(tests?.log).toContain("UNTRUSTED CI LOG")
  })

  test("fails closed when exact-head check evidence is missing or exceeds its bound", async () => {
    for (const checks of [
      [],
      Array.from({ length: 51 }, (_, index) => ({
        id: index,
        name: `Check ${index}`,
        status: "completed",
        conclusion: "success",
      })),
    ]) {
      const evidence = await Effect.runPromise(
        collectHeadEvidence({
          client: github({ listCheckRunPages: () => onePage(checks) }),
          repository: { owner: "owner", repo: "repo" },
          pullRequestNumber: 7,
          target,
          workflowdAppId,
          sonarRequest: sonar(),
        }),
      )

      expect(evidence.ci.state).toBe("unavailable")
      expect(evidence.ci.reason).toBeTruthy()
    }
  })

  test("does not accept required contexts from arbitrary apps or legacy statuses", async () => {
    const spoofedCheckRuns = requiredCheckRuns.map((check) => ({
      ...check,
      appId: 999,
      appSlug: "untrusted-ci",
    }))
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () => onePage(spoofedCheckRuns),
          listCommitStatusPages: () =>
            onePage(
              requiredCheckRuns.map((check) => ({
                context: check.name,
                state: "success" as const,
              })),
            ),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )

    expect(evidence.ci).toMatchObject({
      state: "unavailable",
      reason:
        "Missing required exact-head contexts: Required checks, SonarCloud Code Analysis, CodeQL (JavaScript/TypeScript).",
    })
  })

  test("deduplicates legacy statuses so the newest context state controls gating", async () => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () => onePage(requiredCheckRuns),
          listCommitStatusPages: () =>
            onePage([
              {
                context: "legacy/security",
                state: "success",
                description: "scan passed",
                targetUrl: "https://github.test/status/2",
              },
              {
                context: "legacy/security",
                state: "failure",
                description: "obsolete failure",
                targetUrl: "https://github.test/status/1",
              },
            ]),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )

    const legacy = evidence.ci.checks.filter((check) => check.name === "legacy/security")
    expect(legacy).toHaveLength(1)
    expect(legacy[0]).toMatchObject({ state: "success", conclusion: "success" })
  })

  test("excludes only check runs authenticated as owned by this GitHub App", async () => {
    const selfOnly = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () =>
            onePage([
              {
                id: 1,
                name: "OpenCode Review",
                status: "in_progress",
                appId: workflowdAppId,
                externalId: "review:1",
              },
            ]),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )
    expect(selfOnly.ci).toMatchObject({ state: "unavailable", checks: [] })

    const spoofed = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () =>
            onePage([
              ...requiredCheckRuns,
              { id: 2, name: "OpenCode Review", status: "in_progress", appId: 999 },
            ]),
          listCommitStatusPages: () =>
            onePage([{ context: "Workflowd PR Gate", state: "failure" }]),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )
    expect(
      spoofed.ci.checks.some(
        (check) => check.name === "OpenCode Review" && check.state === "pending",
      ),
    ).toBe(true)
    expect(
      spoofed.ci.checks.some(
        (check) => check.name === "Workflowd PR Gate" && check.state === "failure",
      ),
    ).toBe(true)
  })
})

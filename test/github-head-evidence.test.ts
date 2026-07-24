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

const workflowdRepository = { owner: "BNasraoui", repo: "workflowd" } as const

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
    checkSuiteId: 201,
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
    checkSuiteId: 203,
  },
]

const requiredWorkflowRuns = [
  {
    id: 301,
    name: "CI",
    headSha,
    status: "completed",
    conclusion: "success",
    workflowId: 401,
    path: ".github/workflows/ci.yml",
    checkSuiteId: 201,
  },
  {
    id: 303,
    name: "CodeQL",
    headSha,
    status: "completed",
    conclusion: "success",
    workflowId: 403,
    path: ".github/workflows/codeql.yml",
    checkSuiteId: 203,
  },
]

function github(overrides: Partial<GitHubInstallationAdapter> = {}): GitHubInstallationAdapter {
  return {
    getPullRequest: async () => pull(),
    listIssueCommentPages: () => onePage([]),
    createIssueComment: async () => 1,
    updateIssueComment: async () => 1,
    listCheckRunPages: () => onePage(requiredCheckRuns),
    listWorkflowRunPages: () => onePage(requiredWorkflowRuns),
    getWorkflow: async ({ workflow_id }) => ({
      id: workflow_id.endsWith("ci.yml") ? 401 : 403,
      path: workflow_id,
    }),
    getRepositoryContentSha: async () => "trusted-workflow-blob",
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
        repository: workflowdRepository,
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
    [{ owner: "owner", repo: "repo" }, target],
    [workflowdRepository, { ...target, baseRef: "release" }],
  ] as const)(
    "does not require Workflowd-specific checks or Sonar outside the Workflowd main gate",
    async (repository, reviewTarget) => {
      let sonarRequested = false
      const evidence = await Effect.runPromise(
        collectHeadEvidence({
          client: github({
            getPullRequest: async () => ({
              ...pull(),
              pullRequest: { ...pull().pullRequest, baseRef: reviewTarget.baseRef },
            }),
            listCheckRunPages: () => onePage([]),
          }),
          repository,
          pullRequestNumber: 7,
          target: reviewTarget,
          workflowdAppId,
          sonarRequest: async () => {
            sonarRequested = true
            throw new Error("must not request repository-specific Sonar evidence")
          },
        }),
      )

      expect(evidence.ci).toEqual({ state: "available", checks: [] })
      expect(evidence.sonar).toMatchObject({ state: "pass", headSha })
      expect(sonarRequested).toBe(false)
    },
  )

  test.each([
    ["missing", sonar({ prPresent: false })],
    ["stale", sonar({ head: "c".repeat(40) })],
  ] as const)("fails closed for %s Sonar evidence", async (state, sonarRequest) => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github(),
        repository: workflowdRepository,
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
        repository: workflowdRepository,
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
      repository: workflowdRepository,
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
            onePage([
              ...requiredWorkflowRuns,
              {
                id: 91,
                name: "Other CI",
                headSha,
                status: "completed",
                conclusion: "failure",
                workflowId: 999,
                path: ".github/workflows/other.yml",
              },
            ]),
          listWorkflowJobPages: () =>
            onePage([{ id: 92, name: "Tests", status: "completed", conclusion: "failure" }]),
          downloadWorkflowJobLog: async () =>
            "\u001b[31mfailed\u001b[0m\nAuthorization: Bearer secret\n" + "x".repeat(20_000),
        }),
        repository: workflowdRepository,
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
          repository: workflowdRepository,
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
        repository: workflowdRepository,
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

  test("does not accept forged same-app Actions contexts from another workflow run", async () => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () =>
            onePage(
              requiredCheckRuns.map((check) =>
                check.appSlug === "github-actions" ? { ...check, checkSuiteId: 999 } : check,
              ),
            ),
        }),
        repository: workflowdRepository,
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )

    expect(evidence.ci).toMatchObject({
      state: "unavailable",
      reason:
        "Missing required exact-head contexts: Required checks, CodeQL (JavaScript/TypeScript).",
    })
  })

  test("does not trust an Actions context when the pull request changes its workflow", async () => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          getRepositoryContentSha: async ({ path, ref }) =>
            path.endsWith("ci.yml") && ref === headSha
              ? "pull-request-controlled-workflow"
              : "trusted-workflow-blob",
        }),
        repository: workflowdRepository,
        pullRequestNumber: 7,
        target,
        workflowdAppId,
        sonarRequest: sonar(),
      }),
    )

    expect(evidence.ci).toMatchObject({
      state: "unavailable",
      reason: "Missing required exact-head contexts: Required checks.",
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
        repository: workflowdRepository,
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
        repository: workflowdRepository,
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
        repository: workflowdRepository,
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

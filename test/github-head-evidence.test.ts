import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { collectHeadEvidence } from "../src/github/head-evidence"
import type { GitHubInstallationAdapter } from "../src/github/adapter"

const headSha = "a".repeat(40)
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

function github(overrides: Partial<GitHubInstallationAdapter> = {}): GitHubInstallationAdapter {
  return {
    getPullRequest: async () => pull(),
    listIssueCommentPages: () => onePage([]),
    createIssueComment: async () => 1,
    updateIssueComment: async () => 1,
    listCheckRunPages: () =>
      onePage([
        {
          id: 1,
          name: "Tests",
          status: "completed",
          conclusion: "success",
          appId: 10,
        },
      ]),
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
        sonarRequest: sonar({ issues: 1 }),
      }),
    )

    expect(evidence.headSha).toBe(headSha)
    expect(evidence.ci.checks[0]).toMatchObject({
      name: "SonarCloud Code Analysis",
      state: "success",
    })
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
              { id: 1, name: "OpenCode Review", status: "in_progress" },
              { id: 2, name: "Workflowd PR Gate", status: "completed", conclusion: "failure" },
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
        sonarRequest: sonar(),
      }),
    )

    expect(evidence.ci.checks.map((check) => check.name)).toEqual(["Tests"])
    expect(evidence.ci.checks[0]?.log?.length).toBeLessThanOrEqual(8_000)
    expect(evidence.ci.checks[0]?.log).not.toContain("secret")
    expect(evidence.ci.checks[0]?.log).not.toContain("\u001b")
    expect(evidence.ci.checks[0]?.log).toContain("UNTRUSTED CI LOG")
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
          sonarRequest: sonar(),
        }),
      )

      expect(evidence.ci.state).toBe("unavailable")
      expect(evidence.ci.reason).toBeTruthy()
    }
  })

  test("collects legacy commit statuses and does not wait on self checks", async () => {
    const evidence = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () =>
            onePage([{ id: 1, name: "OpenCode Review", status: "in_progress" }]),
          listCommitStatusPages: () =>
            onePage([
              {
                context: "legacy/security",
                state: "failure",
                description: "scan failed",
                targetUrl: "https://github.test/status/1",
              },
            ]),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        sonarRequest: sonar(),
      }),
    )

    expect(evidence.ci).toMatchObject({
      state: "available",
      checks: [{ name: "legacy/security", state: "failure", conclusion: "failure" }],
    })

    const selfOnly = await Effect.runPromise(
      collectHeadEvidence({
        client: github({
          listCheckRunPages: () =>
            onePage([{ id: 1, name: "OpenCode Review", status: "in_progress" }]),
        }),
        repository: { owner: "owner", repo: "repo" },
        pullRequestNumber: 7,
        target,
        sonarRequest: sonar(),
      }),
    )
    expect(selfOnly.ci).toEqual({ state: "available", checks: [] })
  })
})

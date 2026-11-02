import { afterEach, expect, test } from "bun:test"
import { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import { gateReviewWithHeadEvidence } from "../src/domain/head-evidence"
import { GitObjectId } from "../src/domain/identifiers"
import { GitHubAppAdapter } from "../src/github"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "../src/github/adapter"
import type { SonarRequest } from "../src/github/head-evidence"
import {
  startFakeGitHubRest,
  type FakeCheckRun,
  type FakeGitHubRest,
  type FakeRepository,
} from "./helpers/fake-github-rest"

const headSha = Schema.decodeUnknownSync(GitObjectId)("a".repeat(40))
const baseSha = Schema.decodeUnknownSync(GitObjectId)("b".repeat(40))
const providerAppId = 15368
const workflowdAppId = 10
const approval = { verdict: "pass", summary: "Looks right.", findings: [] } as const

const ciOk: FakeCheckRun = {
  id: 1,
  name: "CI OK",
  conclusion: "success",
  appId: providerAppId,
  appSlug: "github-actions",
  checkSuiteId: 11,
}

const provenance: FakeRepository = {
  baseRef: "main",
  baseSha,
  headRef: "feature",
  headSha,
  rules: [{ context: "CI OK", integrationId: providerAppId }],
  checkRuns: [ciOk],
}

const workflowd: FakeRepository = {
  baseRef: "main",
  baseSha,
  headRef: "feature",
  headSha,
  rules: [{ context: "Required checks", integrationId: providerAppId }],
  checkRuns: [
    { ...ciOk, id: 2, name: "Required checks", checkSuiteId: 21 },
    { ...ciOk, id: 3, name: "SonarCloud Code Analysis", appId: 30, appSlug: "sonarqubecloud" },
    { ...ciOk, id: 4, name: "CodeQL PR policy", checkSuiteId: 23 },
  ],
  workflows: { ".github/workflows/ci.yml": 41, ".github/workflows/codeql.yml": 43 },
  contents: Object.fromEntries(
    [".github/workflows/ci.yml", ".github/workflows/codeql.yml"].flatMap((path) => [
      [`${path}@${baseSha}`, `${path}-blob`],
      [`${path}@${headSha}`, `${path}-blob`],
    ]),
  ),
  workflowRuns: [
    { id: 51, workflowId: 41, path: ".github/workflows/ci.yml", checkSuiteId: 21 },
    { id: 53, workflowId: 43, path: ".github/workflows/codeql.yml", checkSuiteId: 23 },
  ],
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

let server: FakeGitHubRest | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})

async function headEvidence(repositoryFullName: string, repository: FakeRepository) {
  server = startFakeGitHubRest({ [repositoryFullName]: repository })
  const baseUrl = server.url
  const github = new GitHubAppAdapter(
    workflowdAppId,
    async () =>
      new OctokitInstallationAdapter(
        makeOctokitClientPort(new Octokit({ baseUrl, request: { retries: 0 } })),
      ),
    undefined,
    passingSonar,
  )
  const evidence = await Effect.runPromise(
    github.collectHeadEvidence({
      installationId: 1,
      repositoryFullName,
      pullRequestNumber: 7,
      target: {
        baseRef: repository.baseRef,
        baseSha,
        headRef: repository.headRef,
        headRepositoryFullName: repositoryFullName,
        headSha,
      },
    }),
  )
  return { evidence, gated: gateReviewWithHeadEvidence(approval, evidence) }
}

test("a provenance-shaped repository approves with its ruleset's CI OK", async () => {
  const { evidence, gated } = await headEvidence("quality-sh/provenance", provenance)

  expect(evidence.ci.state).toBe("available")
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "pass" } })
  expect(server?.requests).toContain("GET /repos/quality-sh/provenance/rules/branches/main")
})

test.each([
  ["without CI OK", { ...provenance, checkRuns: [] }],
  ["with CI OK from another app", { ...provenance, checkRuns: [{ ...ciOk, appId: 999 }] }],
  [
    "with CI OK only as a commit status",
    { ...provenance, checkRuns: [], statuses: [{ context: "CI OK", state: "success" }] },
  ],
] as const)("a provenance-shaped repository %s does not approve", async (_, repository) => {
  const { evidence, gated } = await headEvidence("quality-sh/provenance", repository)

  expect(evidence.ci).toMatchObject({
    state: "unavailable",
    reason: "Missing required exact-head contexts: CI OK.",
  })
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "changes_requested" } })
})

test("a failed rules read makes CI unavailable rather than unrequired", async () => {
  const { evidence } = await headEvidence("quality-sh/provenance", { ...provenance, rules: 500 })

  expect(evidence.ci).toMatchObject({
    state: "unavailable",
    reason: "Could not read required checks for base main.",
  })
})

test("workflowd main keeps its policy contexts and approves with all three", async () => {
  const { evidence, gated } = await headEvidence("BNasraoui/workflowd", workflowd)

  expect(evidence.ci.state).toBe("available")
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "pass" } })
})

test("workflowd main still requires its policy contexts the ruleset omits", async () => {
  const { evidence } = await headEvidence("BNasraoui/workflowd", {
    ...workflowd,
    checkRuns: workflowd.checkRuns.filter((check) => check.name !== "CodeQL PR policy"),
  })

  expect(evidence.ci).toMatchObject({
    state: "unavailable",
    reason: "Missing required exact-head contexts: CodeQL PR policy.",
  })
})

const ownerRepo: FakeRepository = {
  baseRef: "main",
  baseSha,
  headRef: "feature",
  headSha,
  rules: [{ context: "Required checks", integrationId: providerAppId }],
  checkRuns: [],
}

test("a ruleset context is still required when the base lacks its workflow file", async () => {
  const { evidence, gated } = await headEvidence("owner/repo", ownerRepo)

  expect(evidence.ci).toMatchObject({
    state: "unavailable",
    reason: "Missing required exact-head contexts: Required checks.",
  })
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "changes_requested" } })
})

test("a ruleset context with its base workflow approves from the trusted app", async () => {
  const { evidence, gated } = await headEvidence("owner/repo", {
    ...ownerRepo,
    checkRuns: [workflowd.checkRuns[0]!],
    workflows: { ".github/workflows/ci.yml": 41 },
    contents: {
      [`.github/workflows/ci.yml@${baseSha}`]: "ci-blob",
      [`.github/workflows/ci.yml@${headSha}`]: "ci-blob",
    },
    workflowRuns: [workflowd.workflowRuns![0]!],
  })

  expect(evidence.ci.state).toBe("available")
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "pass" } })
})

test("workflowd main still exempts a policy context whose base workflow is absent", async () => {
  const { evidence, gated } = await headEvidence("BNasraoui/workflowd", {
    ...workflowd,
    checkRuns: workflowd.checkRuns.filter((check) => check.name !== "CodeQL PR policy"),
    workflows: { ".github/workflows/ci.yml": 41 },
    contents: {
      [`.github/workflows/ci.yml@${baseSha}`]: ".github/workflows/ci.yml-blob",
      [`.github/workflows/ci.yml@${headSha}`]: ".github/workflows/ci.yml-blob",
    },
  })

  expect(evidence.ci.state).toBe("available")
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "pass" } })
})

const sonarCheck = workflowd.checkRuns[1]!

test("a workflowd-named ruleset context must come from the ruleset's app", async () => {
  const { evidence, gated } = await headEvidence("owner/repo", {
    ...ownerRepo,
    rules: [{ context: "SonarCloud Code Analysis", integrationId: 999 }],
    checkRuns: [sonarCheck],
  })

  expect(evidence.ci).toMatchObject({
    state: "unavailable",
    reason: "Missing required exact-head contexts: SonarCloud Code Analysis.",
  })
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "changes_requested" } })
})

test("a workflowd-named ruleset context approves from the ruleset's app", async () => {
  const { evidence, gated } = await headEvidence("owner/repo", {
    ...ownerRepo,
    rules: [{ context: "SonarCloud Code Analysis", integrationId: sonarCheck.appId }],
    checkRuns: [sonarCheck],
  })

  expect(evidence.ci.state).toBe("available")
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "pass" } })
})

test("a workflowd-named ruleset context still needs workflowd's app slug", async () => {
  const { evidence } = await headEvidence("owner/repo", {
    ...ownerRepo,
    rules: [{ context: "SonarCloud Code Analysis", integrationId: sonarCheck.appId }],
    checkRuns: [{ ...sonarCheck, appSlug: "impostor" }],
  })

  expect(evidence.ci).toMatchObject({
    state: "unavailable",
    reason: "Missing required exact-head contexts: SonarCloud Code Analysis.",
  })
})

test("workflowd main approves when its ruleset names each context's app", async () => {
  const { evidence, gated } = await headEvidence("BNasraoui/workflowd", {
    ...workflowd,
    rules: [
      { context: "Required checks", integrationId: providerAppId },
      { context: "SonarCloud Code Analysis", integrationId: sonarCheck.appId },
    ],
  })

  expect(evidence.ci.state).toBe("available")
  expect(gated).toMatchObject({ _tag: "Ready", review: { verdict: "pass" } })
})

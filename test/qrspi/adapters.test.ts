import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { QrspiConfig } from "../../src/config"
import {
  BeadsCliTicketSource,
  GitHubQrspiRepository,
  openPullRequestQuery,
} from "../../src/qrspi/adapters"

const reference = {
  tracker: "beads",
  trackerInstanceId: "workspace-42",
  nativeTicketId: "workflowd-vs3.3",
} as const

const repository = {
  providerInstanceId: "github-app-123",
  repositoryId: "42",
  repositoryFullName: "example-owner/example",
} as const

const qrspiConfig = {
  token: "test-token",
  installationId: 123,
  repository,
  trackerInstanceId: "workspace-42",
  beadsWorkspace: "/srv/repository",
  baseRef: "main",
  repositoryOperationTimeoutMs: 30_000,
  operationCompletionMarginMs: 10_000,
  leaseDurationMs: 60_000,
  workflowDefinition: { contractVersion: 1, definitionVersion: 1, stages: [] },
} satisfies QrspiConfig

describe("QRSPI external adapters", () => {
  test("reads Beads through its readonly bounded command envelope", async () => {
    let command: ReadonlyArray<string> = []
    const source = new BeadsCliTicketSource("/srv/repository", "workspace-42", {
      run: (_operation, input, options) =>
        Effect.sync(() => {
          command = input
          expect(options.maxStdoutBytes).toBe(256_000)
          return {
            stdout: new TextEncoder().encode(
              JSON.stringify([{ id: reference.nativeTicketId, issue_type: "feature" }]),
            ),
            truncated: false,
          }
        }),
    })

    await Effect.runPromise(source.read(reference))

    expect(command).toEqual([
      "bd",
      "--readonly",
      "-q",
      "-C",
      "/srv/repository",
      "show",
      reference.nativeTicketId,
      "--json",
    ])
  })

  test("rejects Beads output as soon as the bounded reader reports truncation", async () => {
    const source = new BeadsCliTicketSource("/srv/repository", "workspace-42", {
      run: () => Effect.succeed({ stdout: new TextEncoder().encode("[]"), truncated: true }),
    })

    const exit = await Effect.runPromiseExit(source.read(reference))

    expect(exit._tag).toBe("Failure")
  })

  test("parses the canonical Beads ticket template into the bounded Ticket shape", async () => {
    const source = new BeadsCliTicketSource("/srv/repository", "workspace-42", {
      run: () =>
        Effect.succeed({
          stdout: new TextEncoder().encode(
            JSON.stringify([
              {
                id: reference.nativeTicketId,
                issue_type: "feature",
                title: "Start a durable workflow",
                description: [
                  "## User Story",
                  "As a maintainer, I want kickoff, so that work survives restarts.",
                  "## Description",
                  "Workflowd should start from the accepted product ticket.",
                  "## Sources",
                  "- Contract: https://example.test/contract",
                  "## Out of Scope",
                  "- Stage execution",
                ].join("\n\n"),
                acceptance_criteria: [
                  "## Acceptance Criteria",
                  "- One generation is created.",
                  "## Scenarios",
                  "### Scenario: Start",
                  "**Given** a ready ticket",
                  "**When** kickoff is requested",
                  "**Then** one generation exists",
                ].join("\n\n"),
              },
            ]),
          ),
          truncated: false,
        }),
    })

    const ticket = await Effect.runPromise(source.read(reference))

    expect(ticket).toMatchObject({
      title: "Start a durable workflow",
      userStory: "As a maintainer, I want kickoff, so that work survives restarts.",
      description: "Workflowd should start from the accepted product ticket.",
      sources: ["Contract: https://example.test/contract"],
      acceptanceCriteria: ["One generation is created."],
      scenarios: [{ name: "Start" }],
    })
  })

  test("preserves a weak template as an incomplete decodable ticket", async () => {
    const source = new BeadsCliTicketSource("/srv/repository", "workspace-42", {
      run: () =>
        Effect.succeed({
          stdout: new TextEncoder().encode(
            JSON.stringify([
              { id: reference.nativeTicketId, issue_type: "feature", title: "Needs details" },
            ]),
          ),
          truncated: false,
        }),
    })

    const ticket = await Effect.runPromise(source.read(reference))

    expect(ticket).toEqual({
      reference,
      issueType: "feature",
      title: "Needs details",
    })
  })

  test("returns a typed malformed-ticket error for invalid Beads records", async () => {
    const source = new BeadsCliTicketSource("/srv/repository", "workspace-42", {
      run: () =>
        Effect.succeed({
          stdout: new TextEncoder().encode(
            JSON.stringify([{ id: reference.nativeTicketId, title: "Missing issue type" }]),
          ),
          truncated: false,
        }),
    })

    const exit = await Effect.runPromiseExit(source.read(reference))

    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: { _tag: "TicketSourceMalformedError" } },
    })
  })

  test("queries open pull requests by head regardless of base", () => {
    const parameters = openPullRequestQuery(
      "example-owner",
      "example",
      "feature/workflowd-vs3.3-start",
    )

    expect(parameters).not.toHaveProperty("base")
    expect(parameters).toMatchObject({
      state: "open",
      head: "example-owner:feature/workflowd-vs3.3-start",
    })
  })

  test("accepts the exact previously trusted branch head", async () => {
    const previousTrustedSha = "a".repeat(40)
    const adapter = new GitHubQrspiRepository(qrspiConfig, async () => ({
      rest: {
        repos: {
          get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
          getBranch: async () => ({ data: { commit: { sha: previousTrustedSha } } }),
        },
        pulls: { list: async () => ({ data: [] }) },
        git: { createRef: async () => undefined },
      },
    }))

    const observation = await Effect.runPromise(
      adapter.observeAcceptedBranch({
        repository,
        headRef: "feature/workflowd-vs3.3-start",
        baseSha: "c".repeat(40),
        previousTrustedSha,
      }),
    )

    expect(observation).toEqual({ _tag: "Accepted", sha: previousTrustedSha })
  })

  test("rejects an unrecognized descendant of the previous trusted SHA", async () => {
    const previousTrustedSha = "a".repeat(40)
    const advancedSha = "b".repeat(40)
    const adapter = new GitHubQrspiRepository(qrspiConfig, async () => ({
      rest: {
        repos: {
          get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
          getBranch: async () => ({ data: { commit: { sha: advancedSha } } }),
        },
        pulls: { list: async () => ({ data: [] }) },
        git: { createRef: async () => undefined },
      },
    }))

    const observation = await Effect.runPromise(
      adapter.observeAcceptedBranch({
        repository,
        headRef: "feature/workflowd-vs3.3-start",
        baseSha: "c".repeat(40),
        previousTrustedSha,
      }),
    )

    expect(observation).toEqual({ _tag: "UnknownHistory", sha: advancedSha })
  })
})

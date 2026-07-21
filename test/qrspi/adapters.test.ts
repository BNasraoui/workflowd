import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
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

  test("recovers a closed final pull request created before durable binding", async () => {
    const marker = `<!-- workflowd-pull-request:${"a".repeat(64)} -->`
    const body = `Implementation complete\n\n## Delivery evidence\n- Scenario passes\n\n${marker}`
    const bodySha256 = createHash("sha256").update(body).digest("hex")
    let pull:
      | {
          readonly number: number
          readonly state: string
          readonly title: string
          readonly draft: boolean
          readonly body: string
          readonly html_url: string
          readonly base: { readonly ref: string }
          readonly head: { readonly ref: string; readonly sha: string }
        }
      | undefined
    const adapter = new GitHubQrspiRepository(qrspiConfig, async () => ({
      rest: {
        repos: {
          get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
          getBranch: async () => ({ data: { commit: { sha: "f".repeat(40) } } }),
        },
        pulls: {
          list: async (input) => {
            if (input === undefined) throw new Error("missing pull request query")
            return {
              data:
                pull === undefined || (input.state === "open" && pull.state !== "open")
                  ? []
                  : [pull],
            }
          },
          create: async (input) => {
            if (input === undefined) throw new Error("missing pull request input")
            expect(input.draft).toBe(false)
            pull = {
              number: 17,
              state: "open",
              title: input.title ?? "",
              draft: false,
              body: input.body ?? "",
              html_url: "https://github.test/example-owner/example/pull/17",
              base: { ref: input.base },
              head: { ref: input.head, sha: "f".repeat(40) },
            }
            return { data: { number: 17 } }
          },
        },
        git: { createRef: async () => undefined },
      },
    }))
    const intent = {
      repository,
      baseRef: "main",
      headRef: "feature/workflowd-vs3.3-start",
      headSha: "f".repeat(40),
      title: "Complete QRSPI",
      body,
      bodySha256,
      draft: false as const,
    }

    await Effect.runPromise(adapter.createFinalPullRequest(intent))
    if (pull === undefined) throw new Error("pull request was not created")
    const editedBody = `Edited and closed after creation\n\n${marker}`
    pull = { ...pull, state: "closed", body: editedBody }
    const observed = await Effect.runPromise(adapter.observeFinalPullRequest(intent))

    expect(observed).toMatchObject({
      reference: { repository, number: 17 },
      state: "closed",
      title: intent.title,
      baseRef: "main",
      headRef: intent.headRef,
      headSha: intent.headSha,
      draft: false,
      bodySha256: createHash("sha256").update(editedBody).digest("hex"),
    })
  })

  test("ignores an older closed pull request from a previous generation on the same branch", async () => {
    const oldMarker = `<!-- workflowd-pull-request:${"a".repeat(64)} -->`
    const currentMarker = `<!-- workflowd-pull-request:${"b".repeat(64)} -->`
    const intent = {
      repository,
      baseRef: "main",
      headRef: "feature/workflowd-vs3.3-start",
      headSha: "f".repeat(40),
      title: "Complete current generation",
      body: `Current delivery evidence\n\n${currentMarker}`,
      bodySha256: createHash("sha256")
        .update(`Current delivery evidence\n\n${currentMarker}`)
        .digest("hex"),
      draft: false as const,
    }
    const adapter = new GitHubQrspiRepository(qrspiConfig, async () => ({
      rest: {
        repos: {
          get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
          getBranch: async () => ({ data: { commit: { sha: intent.headSha } } }),
        },
        pulls: {
          list: async () => ({
            data: [
              {
                number: 17,
                state: "closed",
                title: "Complete previous generation",
                draft: false,
                body: `Old delivery evidence\n\n${oldMarker}`,
                html_url: "https://github.test/example-owner/example/pull/17",
                base: { ref: intent.baseRef },
                head: { ref: intent.headRef, sha: "e".repeat(40) },
              },
              {
                number: 18,
                state: "open",
                title: intent.title,
                draft: false,
                body: intent.body,
                html_url: "https://github.test/example-owner/example/pull/18",
                base: { ref: intent.baseRef },
                head: { ref: intent.headRef, sha: intent.headSha },
              },
            ],
          }),
        },
        git: { createRef: async () => undefined },
      },
    }))

    const observed = await Effect.runPromise(adapter.observeFinalPullRequest(intent))

    expect(observed?.reference.number).toBe(18)
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

  test("accepts a signed QRSPI commit linked to its durable publication binding", async () => {
    const previousTrustedSha = "a".repeat(40)
    const advancedSha = "b".repeat(40)
    const controllerId = "11111111-2222-4333-8444-555555555555"
    const operationId = "workflow:1:questions:ArtifactPublish:1"
    const publications: unknown[] = []
    const adapter = new GitHubQrspiRepository(
      qrspiConfig,
      async () => ({
        rest: {
          repos: {
            get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
            getBranch: async () => ({ data: { commit: { sha: advancedSha } } }),
            getCommit: async () => ({
              data: {
                sha: advancedSha,
                parents: [{ sha: previousTrustedSha }],
                commit: {
                  message: `Publish questions\n\nWorkflowd-Job: ${controllerId}:${operationId}`,
                  verification: { verified: true },
                },
              },
            }),
          },
          pulls: { list: async () => ({ data: [] }) },
          git: { createRef: async () => undefined },
        },
      }),
      async (publication) => {
        publications.push(publication)
        return previousTrustedSha
      },
    )

    const observation = await Effect.runPromise(
      adapter.observeAcceptedBranch({
        repository,
        headRef: "feature/workflowd-vs3.3-start",
        baseSha: "c".repeat(40),
        previousTrustedSha,
      }),
    )

    expect(observation).toEqual({ _tag: "Accepted", sha: advancedSha })
    expect(publications).toEqual([
      {
        repository,
        headRef: "feature/workflowd-vs3.3-start",
        controllerId,
        operationId,
        commitSha: advancedSha,
      },
    ])
  })

  test("rejects an unsigned commit even when it is linked to a durable publication", async () => {
    const previousTrustedSha = "a".repeat(40)
    const advancedSha = "b".repeat(40)
    const publications: unknown[] = []
    const adapter = new GitHubQrspiRepository(
      qrspiConfig,
      async () => ({
        rest: {
          repos: {
            get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
            getBranch: async () => ({ data: { commit: { sha: advancedSha } } }),
            getCommit: async () => ({
              data: {
                sha: advancedSha,
                parents: [{ sha: previousTrustedSha }],
                commit: {
                  message: "Apply trusted fix\n\nWorkflowd-Job: 41",
                  verification: { verified: false },
                },
              },
            }),
          },
          pulls: { list: async () => ({ data: [] }) },
          git: { createRef: async () => undefined },
        },
      }),
      async (publication) => {
        publications.push(publication)
        return previousTrustedSha
      },
    )

    const observation = await Effect.runPromise(
      adapter.observeAcceptedBranch({
        repository,
        headRef: "feature/workflowd-vs3.3-start",
        baseSha: "c".repeat(40),
        previousTrustedSha,
      }),
    )

    expect(observation).toEqual({ _tag: "UnknownHistory", sha: advancedSha })
    expect(publications).toEqual([])
  })

  test("rejects unsigned intermediate commits in a durable publication", async () => {
    const previousTrustedSha = "a".repeat(40)
    const intermediateSha = "b".repeat(40)
    const advancedSha = "c".repeat(40)
    const adapter = new GitHubQrspiRepository(
      qrspiConfig,
      async () => ({
        rest: {
          repos: {
            get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
            getBranch: async () => ({ data: { commit: { sha: advancedSha } } }),
            getCommit: async (input) => ({
              data:
                input?.ref === advancedSha
                  ? {
                      sha: advancedSha,
                      parents: [{ sha: intermediateSha }],
                      commit: {
                        message: "Finish fix\n\nWorkflowd-Job: 41",
                        verification: { verified: true },
                      },
                    }
                  : {
                      sha: intermediateSha,
                      parents: [{ sha: previousTrustedSha }],
                      commit: { message: "Start fix" },
                    },
            }),
          },
          pulls: { list: async () => ({ data: [] }) },
          git: { createRef: async () => undefined },
        },
      }),
      async () => previousTrustedSha,
    )

    const observation = await Effect.runPromise(
      adapter.observeAcceptedBranch({
        repository,
        headRef: "feature/workflowd-vs3.3-start",
        baseSha: "d".repeat(40),
        previousTrustedSha,
      }),
    )

    expect(observation).toEqual({ _tag: "UnknownHistory", sha: advancedSha })
  })

  test("rejects a GitHub-verified descendant without a durable publication", async () => {
    const previousTrustedSha = "a".repeat(40)
    const advancedSha = "b".repeat(40)
    const adapter = new GitHubQrspiRepository(
      qrspiConfig,
      async () => ({
        rest: {
          repos: {
            get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
            getBranch: async () => ({ data: { commit: { sha: advancedSha } } }),
            getCommit: async () => ({
              data: {
                sha: advancedSha,
                parents: [{ sha: previousTrustedSha }],
                commit: {
                  message: "Apply untrusted fix\n\nWorkflowd-Job: 41",
                  verification: { verified: true },
                },
              },
            }),
          },
          pulls: { list: async () => ({ data: [] }) },
          git: { createRef: async () => undefined },
        },
      }),
      async () => null,
    )

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

  test("bounds a never-completing repository inspection", async () => {
    const adapter = new GitHubQrspiRepository(
      { ...qrspiConfig, repositoryOperationTimeoutMs: 10 },
      async () => await new Promise(() => undefined),
    )

    const startedAt = Date.now()
    const exit = await Effect.runPromiseExit(adapter.inspect({ repository, baseRef: "main" }))

    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: { _tag: "QrspiRepositoryError" } },
    })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  test("does not create a branch when client acquisition crosses lease expiry", async () => {
    let mutations = 0
    const adapter = new GitHubQrspiRepository(
      { ...qrspiConfig, repositoryOperationTimeoutMs: 500 },
      async () => {
        await Bun.sleep(75)
        return {
          rest: {
            repos: {
              get: async () => ({ data: { id: 42, full_name: "example-owner/example" } }),
              getBranch: async () => ({ data: { commit: { sha: "a".repeat(40) } } }),
            },
            pulls: { list: async () => ({ data: [] }) },
            git: {
              createRef: async () => {
                mutations += 1
              },
            },
          },
        }
      },
    )

    const exit = await Effect.runPromiseExit(
      adapter.createBranch({
        repository,
        headRef: "feature/workflowd-vs3.3-start",
        expectedBaseSha: "a".repeat(40),
        authority: {
          operationId: "operation-1",
          leaseToken: "lease-1",
          leaseUntil: new Date(Date.now() + 50),
        },
      }),
    )

    expect(exit._tag).toBe("Failure")
    expect(mutations).toBe(0)
  })
})

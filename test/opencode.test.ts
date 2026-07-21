import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../src/agent-harness"
import {
  type AutomationPort,
  OpenCodeAutomationAdapter,
  OpenCodeAutomationError,
  RunPullRequestAutomationInput,
  makePullRequestHarnessDefinitions,
} from "../src/opencode"
import type { OpenCodeAdapter, OpenCodeSessionEvent } from "../src/opencode/adapter"

async function* events(
  ...values: ReadonlyArray<OpenCodeSessionEvent>
): AsyncIterable<OpenCodeSessionEvent> {
  yield* values
}

function makeAdapter(overrides: Partial<OpenCodeAdapter> = {}): OpenCodeAdapter {
  return {
    createSession: async () => ({ id: "ses_default" }),
    promptSession: async () => undefined,
    subscribeSessionEvents: async () => events(),
    getSessionStatus: async () => ({ type: "idle" }),
    listSessionMessages: async () => [],
    abortSession: async () => true,
    validateAvailability: async () => undefined,
    ...overrides,
  }
}

const input = Schema.decodeUnknownSync(RunPullRequestAutomationInput)({
  directory: "/tmp/review-worktree",
  repositoryFullName: "example-owner/example",
  pullRequestNumber: 7,
  baseSha: "d".repeat(40),
  headSha: "a".repeat(40),
})

const config = {
  reviewerAgent: "pr-reviewer",
  fixerAgent: "pr-fixer",
  model: "anthropic/claude-sonnet-4-6",
  pollIntervalMs: 0,
  timeoutMs: 10_000,
}

const execution = {
  directory: input.directory,
  scope: {
    _tag: "GenerationScope" as const,
    workflowId: "pr:example-owner/example:7",
    generation: 1,
  },
  operationId: "job:11",
  operationRevision: 1,
  attempt: 1,
  leaseToken: "11111111-1111-4111-8111-111111111111",
  requestedAt: new Date("2026-07-20T12:00:00.000Z"),
}

describe("OpenCodeAutomationAdapter", () => {
  test("requests and decodes structured review output from session events", async () => {
    const prompts: Array<Parameters<OpenCodeAdapter["promptSession"]>[0]> = []
    let statusChecks = 0
    let messageLists = 0
    const adapter = makeAdapter({
      createSession: async () => ({ id: "ses_review_1" }),
      promptSession: async (prompt) => {
        prompts.push(prompt)
      },
      subscribeSessionEvents: async () =>
        events({
          type: "message.updated",
          sessionID: "ses_review_1",
          message: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: {
              verdict: "pass",
              summary: "No actionable findings.",
              findings: [],
            },
          },
        }),
      getSessionStatus: async () => {
        statusChecks += 1
        return { type: "busy" }
      },
      listSessionMessages: async () => {
        messageLists += 1
        return []
      },
    })
    const definitions = makePullRequestHarnessDefinitions(config)
    const harness = new OpenCodeAgentHarness(
      adapter,
      new TrustedAgentHarnessCatalog([definitions.review, definitions.fix]),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        pollIntervalMs: 1,
      },
    )
    const runner: AutomationPort = new OpenCodeAutomationAdapter(harness, definitions)

    const prepared = await Effect.runPromise(runner.prepareReview(input, execution))
    expect(prompts).toHaveLength(0)
    const reference = await Effect.runPromise(harness.createSession(prepared))
    expect(prompts).toHaveLength(0)
    const result = await Effect.runPromise(harness.resumeSession(prepared, reference))

    expect(result).toEqual({
      verdict: "pass",
      summary: "No actionable findings.",
      findings: [],
    })
    expect(prompts[0]).toMatchObject({
      agent: "pr-reviewer",
      format: { type: "json_schema", retryCount: 2 },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      sessionID: "ses_review_1",
    })
    expect(statusChecks).toBe(0)
    expect(messageLists).toBe(0)
  })

  test("runs the fixer with structured completion output", async () => {
    const prompts: Array<Parameters<OpenCodeAdapter["promptSession"]>[0]> = []
    const adapter = makeAdapter({
      createSession: async () => ({ id: "ses_fix_1" }),
      promptSession: async (prompt) => {
        prompts.push(prompt)
      },
      subscribeSessionEvents: async () =>
        events({
          type: "message.updated",
          sessionID: "ses_fix_1",
          message: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: {
              _tag: "CommitPrepared",
              summary: "Prepared the fix commit.",
              commitSha: "c".repeat(40),
            },
          },
        }),
    })
    const definitions = makePullRequestHarnessDefinitions(config)
    const harness = new OpenCodeAgentHarness(
      adapter,
      new TrustedAgentHarnessCatalog([definitions.review, definitions.fix]),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        pollIntervalMs: 1,
      },
    )
    const runner = new OpenCodeAutomationAdapter(harness, definitions)

    const prepared = await Effect.runPromise(
      runner.prepareFix(
        Schema.decodeUnknownSync(RunPullRequestAutomationInput)({
          ...input,
          jobId: 11,
          directory: "/tmp/fix-worktree",
        }),
        { ...execution, directory: "/tmp/fix-worktree" },
      ),
    )
    const reference = await Effect.runPromise(harness.createSession(prepared))
    const result = await Effect.runPromise(harness.resumeSession(prepared, reference))

    expect(result).toMatchObject({
      _tag: "CommitPrepared",
      commitSha: "c".repeat(40),
    })
    expect(prompts[0]).toMatchObject({ agent: "pr-fixer" })
  })

  test("exposes explicit configured agent and model validation", async () => {
    const validations: Array<{
      readonly directory?: string
      readonly agents: ReadonlyArray<string>
      readonly model: { readonly providerID: string; readonly modelID: string }
    }> = []
    const adapter = makeAdapter({
      validateAvailability: async (request) => {
        validations.push(request)
      },
    })
    const definitions = makePullRequestHarnessDefinitions(config)
    const harness = new OpenCodeAgentHarness(
      adapter,
      new TrustedAgentHarnessCatalog([definitions.review, definitions.fix]),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        pollIntervalMs: 1,
      },
    )
    const runner = new OpenCodeAutomationAdapter(harness, definitions)

    await Effect.runPromise(
      runner.validateAvailability({
        directory: "/srv/repository",
        fixWorkEnabled: false,
      }),
    )

    expect(validations).toEqual([
      {
        directory: "/srv/repository",
        agents: ["pr-reviewer"],
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
        },
      },
    ])
  })

  test("uses an automation-wide error tag", () => {
    const error = new OpenCodeAutomationError({
      operation: "review",
      cause: new Error("failed"),
      retryable: true,
    })

    expect(error._tag).toBe("OpenCodeAutomationError")
  })
})

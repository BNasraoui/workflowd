import { describe, expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../src/agent-harness"
import {
  type AutomationPort,
  OpenCodeAutomationAdapter,
  OpenCodeAutomationError,
  RunPullRequestAutomationInput,
  makeOpenCodeHarnessDefinitions,
  makePullRequestHarnessDefinitions,
} from "../src/opencode"
import type { OpenCodeAdapter, OpenCodeSessionEvent } from "../src/opencode/adapter"

const events = (...values: ReadonlyArray<OpenCodeSessionEvent>) => Stream.fromIterable(values)

function makeAdapter(overrides: Partial<OpenCodeAdapter> = {}): OpenCodeAdapter {
  return {
    createSession: () => Effect.succeed({ id: "ses_default" }),
    promptSession: () => Effect.void,
    subscribeSessionEvents: () => events(),
    getSessionStatus: () => Effect.succeed({ type: "idle" as const }),
    sessionExists: () => Effect.succeed(true),
    listSessionMessages: () => Effect.succeed([]),
    abortSession: () => Effect.succeed(true),
    validateAvailability: () => Effect.void,
    generateStructured: () => Effect.succeed({}),
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
  test("keeps PR registrations distinct when the stage harness is registered", () => {
    const definitions = makeOpenCodeHarnessDefinitions(config)
    const catalog = new TrustedAgentHarnessCatalog(Object.values(definitions))

    expect(catalog.describe(definitions.review.ref).ref).toEqual({
      name: "opencode.pr-review",
      version: 1,
    })
    expect(catalog.describe(definitions.fix.ref).ref).toEqual({
      name: "opencode.pr-fix",
      version: 1,
    })
    expect(catalog.describe(definitions.stage.ref).ref).toEqual({
      name: "opencode",
      version: 1,
    })
    expect(definitions.review.prompt(input)).not.toBe(definitions.fix.prompt(input))
    expect(definitions.review.outputSchema).not.toBe(definitions.fix.outputSchema)
  })

  test("requests and decodes structured review output from session events", async () => {
    const prompts: Array<Parameters<OpenCodeAdapter["promptSession"]>[0]> = []
    let statusChecks = 0
    let messageLists = 0
    const adapter = makeAdapter({
      createSession: () => Effect.succeed({ id: "ses_review_1" }),
      promptSession: (prompt) => {
        prompts.push(prompt)
        return Effect.void
      },
      subscribeSessionEvents: () =>
        events({
          type: "message.updated",
          sessionID: "ses_review_1",
          message: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } },
        }),
      getSessionStatus: () => {
        statusChecks += 1
        return Effect.succeed({ type: "busy" as const })
      },
      listSessionMessages: () => {
        messageLists += 1
        return Effect.succeed([
          { id: "msg_1", role: "assistant" as const, time: { created: 1, completed: 2 } },
        ])
      },
      generateStructured: () =>
        Effect.succeed({
          verdict: "pass",
          summary: "No actionable findings.",
          findings: [],
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
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      sessionID: "ses_review_1",
    })
    expect(statusChecks).toBe(0)
    expect(messageLists).toBe(1)
  })

  test("runs the fixer with structured completion output", async () => {
    const prompts: Array<Parameters<OpenCodeAdapter["promptSession"]>[0]> = []
    const adapter = makeAdapter({
      createSession: () => Effect.succeed({ id: "ses_fix_1" }),
      promptSession: (prompt) => {
        prompts.push(prompt)
        return Effect.void
      },
      subscribeSessionEvents: () =>
        events({
          type: "message.updated",
          sessionID: "ses_fix_1",
          message: { id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } },
        }),
      listSessionMessages: () =>
        Effect.succeed([
          { id: "msg_1", role: "assistant" as const, time: { created: 1, completed: 2 } },
        ]),
      generateStructured: () =>
        Effect.succeed({
          _tag: "CommitPrepared",
          summary: "Prepared the fix commit.",
          commitSha: "c".repeat(40),
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
      validateAvailability: (request) => {
        validations.push(request)
        return Effect.void
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

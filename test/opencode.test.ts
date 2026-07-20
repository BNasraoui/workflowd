import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  type AutomationPort,
  OpenCodeAutomationAdapter,
  OpenCodeAutomationError,
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

const input = {
  directory: "/tmp/review-worktree",
  repositoryFullName: "example-owner/example",
  pullRequestNumber: 7,
  baseSha: "def456",
  headSha: "abc123",
}

const config = {
  reviewerAgent: "pr-reviewer",
  fixerAgent: "pr-fixer",
  model: "anthropic/claude-sonnet-4-6",
  pollIntervalMs: 0,
}

describe("OpenCodeAutomationAdapter", () => {
  test("requests and decodes structured review output from session events", async () => {
    const prompts: Array<Parameters<OpenCodeAdapter["promptSession"]>[0]> = []
    let statusChecks = 0
    let messageLists = 0
    const runner: AutomationPort = new OpenCodeAutomationAdapter(
      makeAdapter({
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
      }),
      config,
    )

    const result = await Effect.runPromise(runner.runReview(input))

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
    const runner = new OpenCodeAutomationAdapter(
      makeAdapter({
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
      }),
      config,
    )

    const result = await Effect.runPromise(
      runner.runFix({ ...input, directory: "/tmp/fix-worktree" }),
    )

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
    const runner = new OpenCodeAutomationAdapter(
      makeAdapter({
        validateAvailability: async (request) => {
          validations.push(request)
        },
      }),
      config,
    )

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
    })

    expect(error._tag).toBe("OpenCodeAutomationError")
  })
})

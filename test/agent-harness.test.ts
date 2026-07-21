import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../src/agent-harness"
import type { OpenCodeAdapter, OpenCodeSessionEvent } from "../src/opencode/adapter"

async function* events(
  ...values: ReadonlyArray<OpenCodeSessionEvent>
): AsyncIterable<OpenCodeSessionEvent> {
  yield* values
}

function makeAdapter(overrides: Partial<OpenCodeAdapter> = {}): OpenCodeAdapter {
  return {
    createSession: async () => ({ id: "ses_fixture" }),
    promptSession: async () => undefined,
    subscribeSessionEvents: async () => events(),
    getSessionStatus: async () => ({ type: "busy" }),
    listSessionMessages: async () => [],
    abortSession: async () => true,
    validateAvailability: async () => undefined,
    ...overrides,
  }
}

const fixtureDefinition = {
  ref: { name: "fixture.summary", version: 1 },
  agent: "fixture-agent",
  model: "openai/gpt-5.6-sol",
  inputSchema: Schema.Struct({ text: Schema.String.pipe(Schema.maxLength(100)) }),
  outputSchema: Schema.Struct({ summary: Schema.String.pipe(Schema.maxLength(100)) }),
  promptContract: "fixture-summary-prompt",
  title: () => "fixture summary",
  prompt: (input: { readonly text: string }) => `Summarize: ${input.text}`,
  timeoutMs: 1_000,
  retryPolicy: {
    maxAttempts: 2,
    structuredOutputRetryCount: 1,
    invalidOutput: "retry" as const,
  },
}

describe("TrustedAgentHarnessCatalog", () => {
  test("rejects duplicate stable harness references", () => {
    expect(() => new TrustedAgentHarnessCatalog([fixtureDefinition, fixtureDefinition])).toThrow(
      "Duplicate AgentHarness reference fixture.summary@1",
    )
  })

  test("rejects an unknown stable harness reference", () => {
    const catalog = new TrustedAgentHarnessCatalog([fixtureDefinition])

    expect(() => catalog.definition({ name: "fixture.missing", version: 1 })).toThrow(
      "Unknown AgentHarness reference fixture.missing@1",
    )
  })

  test("validates trusted definitions before they can be selected", () => {
    const invalidDefinitions = [
      { ...fixtureDefinition, agent: "invalid agent" },
      { ...fixtureDefinition, model: "missing-provider" },
      { ...fixtureDefinition, outputSchema: Schema.BigIntFromSelf },
      { ...fixtureDefinition, timeoutMs: 0 },
      {
        ...fixtureDefinition,
        retryPolicy: { ...fixtureDefinition.retryPolicy, maxAttempts: 0 },
      },
      {
        ...fixtureDefinition,
        retryPolicy: {
          ...fixtureDefinition.retryPolicy,
          structuredOutputRetryCount: -1,
        },
      },
    ]

    for (const definition of invalidDefinitions) {
      expect(() => new TrustedAgentHarnessCatalog([definition])).toThrow()
    }
  })
})

describe("OpenCodeAgentHarness", () => {
  test("executes non-PR typed work through explicit durable session phases", async () => {
    const actions: Array<string> = []
    const harness = new OpenCodeAgentHarness(
      makeAdapter({
        createSession: async () => {
          actions.push("create")
          return { id: "ses_fixture" }
        },
        promptSession: async () => {
          actions.push("prompt")
        },
        subscribeSessionEvents: async () =>
          events({
            type: "message.updated",
            sessionID: "ses_fixture",
            message: {
              role: "assistant",
              time: { created: 1, completed: 2 },
              structured: { summary: "A short summary." },
            },
          }),
      }),
      new TrustedAgentHarnessCatalog([fixtureDefinition]),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        pollIntervalMs: 1,
      },
    )

    const prepared = await Effect.runPromise(
      harness.prepare(
        fixtureDefinition,
        { text: "A bounded fixture input." },
        {
          directory: "/tmp/fixture-worktree",
          scope: {
            _tag: "GenerationScope",
            workflowId: "fixture-workflow",
            generation: 3,
          },
          operationId: "fixture-operation",
          operationRevision: 1,
          attempt: 2,
          leaseToken: "11111111-1111-4111-8111-111111111111",
          requestedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      ),
    )

    expect(prepared.launchIntent).toMatchObject({
      harness: fixtureDefinition.ref,
      agent: "fixture-agent",
      model: "openai/gpt-5.6-sol",
      input: { text: "A bounded fixture input." },
      operationId: "fixture-operation",
      operationRevision: 1,
      attempt: 2,
      leaseToken: "11111111-1111-4111-8111-111111111111",
      directory: "/tmp/fixture-worktree",
      requestedAt: "2026-07-20T12:00:00.000Z",
    })
    expect(prepared.launchIntent.definitionHash).toMatch(/^[0-9a-f]{64}$/)

    const reference = await Effect.runPromise(harness.createSession(prepared))

    expect(actions).toEqual(["create"])
    expect(reference).toMatchObject({
      sessionReferenceId: prepared.launchIntent.sessionReferenceId,
      serverId: "opencode-primary",
      endpointAlias: "private-opencode",
      directory: "/tmp/fixture-worktree",
      nativeSessionId: "ses_fixture",
      operationId: "fixture-operation",
      operationRevision: 1,
      attempt: 2,
      leaseToken: "11111111-1111-4111-8111-111111111111",
      state: "created",
    })

    const result = await Effect.runPromise(harness.resumeSession(prepared, reference))

    expect(result).toEqual({ summary: "A short summary." })
    expect(actions).toEqual(["create", "prompt"])
  })

  test("rejects persisted references for a different OpenCode endpoint", async () => {
    let prompted = 0
    let aborted = 0
    const harness = new OpenCodeAgentHarness(
      makeAdapter({
        promptSession: async () => {
          prompted += 1
          throw new Error("unexpected prompt")
        },
        abortSession: async () => {
          aborted += 1
          return true
        },
      }),
      new TrustedAgentHarnessCatalog([fixtureDefinition]),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        pollIntervalMs: 1,
      },
    )
    const prepared = await Effect.runPromise(
      harness.prepare(
        fixtureDefinition,
        { text: "A bounded fixture input." },
        {
          directory: "/tmp/fixture-worktree",
          scope: { _tag: "WorkflowScope", workflowId: "fixture-workflow" },
          operationId: "fixture-operation",
          operationRevision: 1,
          attempt: 1,
          leaseToken: "11111111-1111-4111-8111-111111111111",
          requestedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      ),
    )
    const reference = await Effect.runPromise(harness.createSession(prepared))
    const mismatchedReferences = [
      { ...reference, serverId: "opencode-secondary" },
      { ...reference, endpointAlias: "public-opencode" },
    ]

    for (const mismatchedReference of mismatchedReferences) {
      const failure = await Effect.runPromise(
        harness.resumeSession(prepared, mismatchedReference).pipe(Effect.flip),
      )
      expect(failure.operation).toBe("validate SessionReference")
      const abortFailure = await Effect.runPromise(
        harness.abortSession(mismatchedReference).pipe(Effect.flip),
      )
      expect(abortFailure.operation).toBe("abort session")
    }
    expect(prompted).toBe(0)
    expect(aborted).toBe(0)
  })

  test("fails when OpenCode does not confirm a session abort", async () => {
    const harness = new OpenCodeAgentHarness(
      makeAdapter({ abortSession: async () => false }),
      new TrustedAgentHarnessCatalog([fixtureDefinition]),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        pollIntervalMs: 1,
      },
    )
    const prepared = await Effect.runPromise(
      harness.prepare(
        fixtureDefinition,
        { text: "A bounded fixture input." },
        {
          directory: "/tmp/fixture-worktree",
          scope: { _tag: "WorkflowScope", workflowId: "fixture-workflow" },
          operationId: "fixture-operation",
          operationRevision: 1,
          attempt: 1,
          leaseToken: "11111111-1111-4111-8111-111111111111",
          requestedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      ),
    )
    const reference = await Effect.runPromise(harness.createSession(prepared))

    const failure = await Effect.runPromise(harness.abortSession(reference).pipe(Effect.flip))

    expect(failure.operation).toBe("abort session")
  })

  test("marks invalid structured output terminal when the trusted policy says fail", async () => {
    const definition = {
      ...fixtureDefinition,
      ref: { name: "fixture.terminal", version: 1 },
      retryPolicy: {
        ...fixtureDefinition.retryPolicy,
        invalidOutput: "fail" as const,
      },
    }
    const harness = new OpenCodeAgentHarness(
      makeAdapter({
        subscribeSessionEvents: async () =>
          events({
            type: "message.updated",
            sessionID: "ses_fixture",
            message: {
              role: "assistant",
              time: { created: 1, completed: 2 },
              structured: { summary: 42 },
            },
          }),
      }),
      new TrustedAgentHarnessCatalog([definition]),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        pollIntervalMs: 1,
      },
    )
    const prepared = await Effect.runPromise(
      harness.prepare(
        definition,
        { text: "A bounded fixture input." },
        {
          directory: "/tmp/fixture-worktree",
          scope: { _tag: "WorkflowScope", workflowId: "fixture-workflow" },
          operationId: "fixture-terminal",
          operationRevision: 1,
          attempt: 1,
          leaseToken: "11111111-1111-4111-8111-111111111111",
          requestedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      ),
    )
    const reference = await Effect.runPromise(harness.createSession(prepared))
    const failure = await Effect.runPromise(
      harness.resumeSession(prepared, reference).pipe(Effect.flip),
    )

    expect(failure.operation).toBe("decode structured session output")
    expect(failure.retryable).toBe(false)
  })
})

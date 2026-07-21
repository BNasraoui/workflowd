import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  MAX_AGENT_LAUNCH_INTENT_BYTES,
  MAX_AGENT_OUTPUT_BYTES,
  OpenCodeAgentHarness,
  TrustedAgentHarnessCatalog,
} from "../src/agent-harness"
import { makePullRequestHarnessDefinitions } from "../src/opencode"
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
  maxInputBytes: 611,
  maxOutputBytes: 614,
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

  test("retains an active policy variant across current configuration changes", () => {
    const catalog = new TrustedAgentHarnessCatalog([fixtureDefinition])
    const retained = {
      ...fixtureDefinition,
      model: "anthropic/claude-sonnet-4",
      timeoutMs: 2_000,
    }

    catalog.retain([retained])

    expect(catalog.registrationFor(retained).definition).toMatchObject({
      model: "anthropic/claude-sonnet-4",
      timeoutMs: 2_000,
    })
    expect(catalog.registrationFor(fixtureDefinition).definition.model).toBe("openai/gpt-5.6-sol")
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

  test("rejects trusted definitions whose declared limits exceed durable envelopes", () => {
    const oversizedInput = {
      ...fixtureDefinition,
      maxInputBytes: MAX_AGENT_LAUNCH_INTENT_BYTES + 1,
    }
    const oversizedOutput = {
      ...fixtureDefinition,
      maxOutputBytes: MAX_AGENT_OUTPUT_BYTES + 1,
    }
    expect(() => new TrustedAgentHarnessCatalog([oversizedInput])).toThrow("input limit")
    expect(() => new TrustedAgentHarnessCatalog([oversizedOutput])).toThrow("output limit")
  })

  test("registers maximum valid built-in trusted payload declarations", () => {
    const definitions = makePullRequestHarnessDefinitions({
      reviewerAgent: "pr-reviewer",
      fixerAgent: "pr-fixer",
      model: "openai/gpt-5.6-sol",
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    })

    expect(definitions.review.maxInputBytes).toBe(26_363)
    expect(definitions.review.maxOutputBytes).toBe(3_395_207)
    expect(definitions.fix.maxOutputBytes).toBe(24_117)
    expect(() => new TrustedAgentHarnessCatalog(Object.values(definitions))).not.toThrow()
  })

  test("accepts the maximum valid built-in input inside the launch envelope", async () => {
    const definitions = makePullRequestHarnessDefinitions({
      reviewerAgent: "pr-reviewer",
      fixerAgent: "pr-fixer",
      model: "openai/gpt-5.6-sol",
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    })
    const harness = new OpenCodeAgentHarness(
      makeAdapter(),
      new TrustedAgentHarnessCatalog(Object.values(definitions)),
      { serverId: "opencode-primary", endpointAlias: "private-opencode", pollIntervalMs: 1 },
    )
    const escaped = "\u0001"
    const input = {
      jobId: Number.MAX_SAFE_INTEGER,
      directory: `/${escaped.repeat(4_095)}`,
      repositoryFullName: escaped.repeat(256),
      pullRequestNumber: Number.MAX_SAFE_INTEGER,
      baseSha: "a".repeat(64),
      headSha: "b".repeat(64),
    }

    expect(Buffer.byteLength(JSON.stringify(input))).toBe(26_363)
    const prepared = await Effect.runPromise(
      harness.prepare(definitions.review, input, {
        directory: "/tmp/worktree",
        scope: { _tag: "WorkflowScope", workflowId: "fixture-workflow" },
        operationId: "fixture-operation",
        operationRevision: 1,
        attempt: 1,
        leaseToken: "11111111-1111-4111-8111-111111111111",
        requestedAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    )

    expect(Buffer.byteLength(JSON.stringify(prepared.launchIntent))).toBeLessThanOrEqual(
      MAX_AGENT_LAUNCH_INTENT_BYTES,
    )
  })
})

describe("OpenCodeAgentHarness", () => {
  test("enforces trusted per-harness input limits below the global envelope", async () => {
    const definition = { ...fixtureDefinition, maxInputBytes: 10 }
    const harness = new OpenCodeAgentHarness(
      makeAdapter(),
      new TrustedAgentHarnessCatalog([definition]),
      { serverId: "opencode-primary", endpointAlias: "private-opencode", pollIntervalMs: 1 },
    )

    const failure = await Effect.runPromise(
      harness
        .prepare(
          definition,
          { text: "This input exceeds ten encoded bytes." },
          {
            directory: "/tmp/fixture-worktree",
            scope: { _tag: "WorkflowScope", workflowId: "fixture-workflow" },
            operationId: "fixture-operation",
            operationRevision: 1,
            attempt: 1,
            leaseToken: "11111111-1111-4111-8111-111111111111",
            requestedAt: new Date("2026-07-20T12:00:00.000Z"),
          },
        )
        .pipe(Effect.flip),
    )

    expect(failure.operation).toBe("validate encoded agent prompt input")
  })

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

  test("orphans a session whose create response is lost and creates a replacement", async () => {
    let creates = 0
    const adapter = {
      ...makeAdapter(),
      findSession: async () => ({ id: "ses_orphaned" }),
      createSession: async () => {
        creates += 1
        if (creates === 1) throw new Error("connection closed after create")
        return { id: "ses_replacement" }
      },
    } as OpenCodeAdapter
    const harness = new OpenCodeAgentHarness(
      adapter,
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

    const createFailure = await Effect.runPromise(harness.createSession(prepared).pipe(Effect.flip))
    expect(createFailure.cause.message).toContain("connection closed after create")
    const replacement = await Effect.runPromise(
      harness.prepare(
        fixtureDefinition,
        { text: "A bounded fixture input." },
        {
          directory: "/tmp/fixture-worktree",
          scope: { _tag: "WorkflowScope", workflowId: "fixture-workflow" },
          operationId: "fixture-operation",
          operationRevision: 1,
          attempt: 2,
          leaseToken: "22222222-2222-4222-8222-222222222222",
          requestedAt: new Date("2026-07-20T12:02:00.000Z"),
        },
      ),
    )
    const recovered = await Effect.runPromise(harness.createSession(replacement))

    expect(recovered.nativeSessionId).toBe("ses_replacement")
    expect(recovered.attempt).toBe(2)
    expect(creates).toBe(2)
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

  test("leaves failed session cleanup to the harness lifecycle owner", async () => {
    let aborts = 0
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
        abortSession: async () => {
          aborts += 1
          return aborts === 1
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

    const failure = await Effect.runPromise(
      harness.resumeSession(prepared, reference).pipe(Effect.flip),
    )
    await Effect.runPromise(harness.abortSession(reference))

    expect(failure.operation).toBe("decode structured session output")
    expect(failure.retryable).toBe(true)
    expect(aborts).toBe(1)
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

import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { AgentHarnessPort } from "../../src/agent-harness"
import {
  BuiltInStageContracts,
  StageCatalog,
  defaultQrspiWorkflowDefinition,
  validateWorkflowDefinition,
  makeQrspiHarnessDefinitions,
  qrspiHarnessDefinitionsForWorkflows,
  runStageContract,
  type StageContract,
} from "../../src/qrspi/stages"

const readyTicket = {
  reference: {
    tracker: "beads" as const,
    trackerInstanceId: "workspace-42",
    nativeTicketId: "workflowd-vs3.4",
  },
  issueType: "feature" as const,
  title: "Deliver authoritative stage context",
  description: "Every QRSPI producer must receive the decoded ready ticket.",
  sources: ["https://example.test/ticket"],
  acceptanceCriteria: ["The producer receives the ticket acceptance criteria."],
  scenarios: [
    {
      name: "Producer receives context",
      given: "a ready ticket",
      when: "a stage starts",
      then: "the complete ticket is included in the task",
      covers: [0],
    },
  ],
}

describe("StageCatalog", () => {
  test("registers the six versioned built-in contracts in deterministic order", () => {
    const catalog = new StageCatalog(BuiltInStageContracts)

    expect(catalog.contracts.map(({ ref }) => ref)).toEqual([
      { name: "Questions", contractVersion: 1 },
      { name: "Research", contractVersion: 1 },
      { name: "Design", contractVersion: 1 },
      { name: "Structure", contractVersion: 1 },
      { name: "Plan", contractVersion: 1 },
      { name: "Implementation", contractVersion: 1 },
    ])
    expect(defaultQrspiWorkflowDefinition.stages.map(({ key }) => key)).toEqual([
      "questions",
      "research",
      "design",
      "structure",
      "plan",
      "implementation",
    ])
  })

  test("restores a selected contract's types by decoding input and result", () => {
    const catalog = new StageCatalog(BuiltInStageContracts)
    const resolved = catalog.resolve({ name: "Questions", contractVersion: 1 })
    const input = resolved.decodeInput({
      ticketRevisionSha256: "a".repeat(64),
      readyTicket,
      sources: [],
    })

    expect(resolved.task(input)).toContain("Questions")
    expect(resolved.task(input)).toContain(readyTicket.title)
    expect(resolved.task(input)).toContain(readyTicket.description)
    expect(resolved.task(input)).toContain(readyTicket.acceptanceCriteria[0]!)
    expect(resolved.task(input)).toContain(readyTicket.scenarios[0]!.then)
    expect(
      resolved.decodeResult({
        candidateSha: "a".repeat(40),
        content: "# Questions\n\nNone.",
        summary: "No questions",
      }),
    ).toEqual({
      candidateSha: "a".repeat(40),
      content: "# Questions\n\nNone.",
      summary: "No questions",
    })
    expect(() => resolved.decodeResult({ content: "" })).toThrow()
  })

  test("extends with another built-in contract without changing orchestration", () => {
    const fixture = {
      ref: { name: "Fixture", contractVersion: 1 },
      kind: "document",
      inputSchema: Schema.Struct({ value: Schema.String }),
      resultSchema: Schema.Struct({ content: Schema.String, summary: Schema.String }),
      task: ({ value }: { readonly value: string }) => `Fixture: ${value}`,
    } satisfies StageContract<
      { readonly value: string },
      { readonly value: string },
      { readonly content: string; readonly summary: string },
      { readonly content: string; readonly summary: string }
    >

    const catalog = new StageCatalog([...BuiltInStageContracts, fixture])

    expect(catalog.resolve(fixture.ref).decodeInput({ value: "works" })).toEqual({ value: "works" })
  })

  test("rejects duplicate, unknown, incompatible, and unavailable references at startup", () => {
    expect(() => new StageCatalog([...BuiltInStageContracts, BuiltInStageContracts[0]])).toThrow(
      "Duplicate StageContract reference Questions@1",
    )
    const catalog = new StageCatalog(BuiltInStageContracts)
    expect(() => catalog.resolve({ name: "Questions", contractVersion: 2 })).toThrow(
      "Unknown StageContract reference Questions@2",
    )

    expect(() =>
      validateWorkflowDefinition(defaultQrspiWorkflowDefinition, catalog, [
        { name: "qrspi.document", version: 1 },
      ]),
    ).toThrow("Unknown AgentHarness reference qrspi.implementation@1")
  })

  test("rejects producer policy that does not match the trusted harness definition", () => {
    const definitions = makeQrspiHarnessDefinitions({
      agent: "qrspi-producer",
      model: "openai/gpt-5.6-sol",
      timeoutMs: 1_000,
    })
    const changed = {
      ...defaultQrspiWorkflowDefinition,
      stages: [
        {
          ...defaultQrspiWorkflowDefinition.stages[0]!,
          producer: {
            ...defaultQrspiWorkflowDefinition.stages[0]!.producer,
            agent: "repository-controlled-agent",
          },
        },
      ],
    }

    expect(() =>
      validateWorkflowDefinition(changed, new StageCatalog(BuiltInStageContracts), [
        definitions.document,
        definitions.implementation,
      ]),
    ).toThrow("Untrusted harness policy for stage questions")
  })

  test("builds every active configured and retained producer policy as a trusted variant", () => {
    const currentStage = {
      ...defaultQrspiWorkflowDefinition.stages[0]!,
      producer: {
        ...defaultQrspiWorkflowDefinition.stages[0]!.producer,
        harnessId: "custom.document",
        harnessVersion: 4,
        agent: "current-agent",
        model: "anthropic/claude-sonnet-4",
        timeoutMs: 45_000,
        retry: { maxAttempts: 5, backoffMs: 2_000 },
      },
    }
    const retainedStage = {
      ...currentStage,
      producer: {
        ...currentStage.producer,
        agent: "retained-agent",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 90_000,
      },
    }
    const variants = qrspiHarnessDefinitionsForWorkflows([
      { ...defaultQrspiWorkflowDefinition, stages: [currentStage] },
      { ...defaultQrspiWorkflowDefinition, definitionVersion: 2, stages: [retainedStage] },
    ])

    expect(
      variants.map(({ ref, agent, model, timeoutMs, retryPolicy }) => ({
        ref,
        agent,
        model,
        timeoutMs,
        maxAttempts: retryPolicy.maxAttempts,
      })),
    ).toEqual([
      {
        ref: { name: "custom.document", version: 4 },
        agent: "current-agent",
        model: "anthropic/claude-sonnet-4",
        timeoutMs: 45_000,
        maxAttempts: 5,
      },
      {
        ref: { name: "custom.document", version: 4 },
        agent: "retained-agent",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 90_000,
        maxAttempts: 5,
      },
    ])
  })

  test("disabled stages are omitted while a conditional skip records its reason", () => {
    const catalog = new StageCatalog(BuiltInStageContracts)
    const definition = {
      ...defaultQrspiWorkflowDefinition,
      stages: defaultQrspiWorkflowDefinition.stages.map((stage, index) =>
        index === 0
          ? { ...stage, activation: { mode: "disabled" as const } }
          : index === 1
            ? {
                ...stage,
                activation: {
                  mode: "conditional" as const,
                  policyId: "fixture-policy",
                  policyVersion: 1,
                  decision: "disabled" as const,
                },
              }
            : stage,
      ),
    }

    const plan = validateWorkflowDefinition(definition, catalog, [
      { name: "qrspi.document", version: 1 },
      { name: "qrspi.implementation", version: 1 },
    ]).executionPlan

    expect(plan.some(({ stage }) => stage.key === "questions")).toBe(false)
    expect(plan.find(({ stage }) => stage.key === "research")).toMatchObject({
      initialState: "skipped",
      skipReason: "fixture-policy@1 disabled the stage",
    })
  })

  test("rejects an implementation stage followed by another runnable stage", () => {
    const implementation = defaultQrspiWorkflowDefinition.stages[5]!
    const questions = defaultQrspiWorkflowDefinition.stages[0]!

    expect(() =>
      validateWorkflowDefinition(
        { ...defaultQrspiWorkflowDefinition, stages: [implementation, questions] },
        new StageCatalog(BuiltInStageContracts),
        [
          { name: "qrspi.document", version: 1 },
          { name: "qrspi.implementation", version: 1 },
        ],
      ),
    ).toThrow("Implementation stage must be terminal: implementation")
  })

  test("runs any selected contract through the selected AgentHarness without publication authority", async () => {
    const actions: Array<string> = []
    const definitions = makeQrspiHarnessDefinitions({
      agent: "qrspi-producer",
      model: "openai/gpt-5.6-sol",
      timeoutMs: 1_000,
    })
    const harness: AgentHarnessPort = {
      validateAvailability: () => Effect.void,
      prepare: (definition, input, context) => {
        actions.push(`prepare:${definition.ref.name}`)
        return Schema.decodeUnknown(definition.inputSchema)(input).pipe(
          Effect.orDie,
          Effect.map((decoded) => ({
            launchIntent: {
              sessionReferenceId: "session-ref",
              harness: definition.ref,
              definitionHash: "a".repeat(64),
              agent: definition.agent,
              model: definition.model,
              input: decoded,
              scope: context.scope,
              operationId: context.operationId,
              operationRevision: context.operationRevision,
              attempt: context.attempt,
              leaseToken: context.leaseToken,
              directory: context.directory,
              timeoutMs: definition.timeoutMs,
              retryPolicy: definition.retryPolicy,
              requestedAt: context.requestedAt.toISOString(),
            },
            title: "QRSPI",
            prompt: "prompt",
            model: { providerID: "openai", modelID: "gpt-5.6-sol" },
            outputSchema: definition.outputSchema,
            outputJsonSchema: {},
            maxOutputBytes: definition.maxOutputBytes,
            pollIntervalMs: 1,
          })),
        )
      },
      createSession: (prepared) => {
        actions.push("create")
        return Effect.succeed({
          sessionReferenceId: prepared.launchIntent.sessionReferenceId,
          serverId: "opencode-primary",
          endpointAlias: "private-opencode",
          directory: prepared.launchIntent.directory,
          nativeSessionId: "native-session",
          scope: prepared.launchIntent.scope,
          operationId: prepared.launchIntent.operationId,
          operationRevision: prepared.launchIntent.operationRevision,
          attempt: prepared.launchIntent.attempt,
          leaseToken: prepared.launchIntent.leaseToken,
          createdAt: "2026-07-21T12:00:00.000Z",
          state: "created",
        })
      },
      resumeSession: (prepared) => {
        actions.push("resume")
        return Schema.decodeUnknown(prepared.outputSchema)({
          candidateSha: "a".repeat(40),
          content: "# Questions",
          summary: "Answered",
        }).pipe(Effect.orDie)
      },
      abortSession: () => Effect.void,
    }

    const output = await Effect.runPromise(
      runStageContract({
        catalog: new StageCatalog(BuiltInStageContracts),
        harness,
        harnessDefinitions: definitions,
        stage: defaultQrspiWorkflowDefinition.stages[0]!,
        input: { ticketRevisionSha256: "a".repeat(64), readyTicket, sources: [] },
        context: {
          directory: "/tmp/qrspi-stage",
          scope: { _tag: "GenerationScope", workflowId: "workflow", generation: 1 },
          operationId: "operation",
          operationRevision: 1,
          attempt: 1,
          leaseToken: "11111111-1111-4111-8111-111111111111",
          requestedAt: new Date("2026-07-21T12:00:00.000Z"),
        },
      }),
    )

    expect(output.result).toEqual({
      candidateSha: "a".repeat(40),
      content: "# Questions",
      summary: "Answered",
    })
    expect(output.sessionReference.nativeSessionId).toBe("native-session")
    expect(actions).toEqual(["prepare:qrspi.document", "create", "resume"])
  })
})

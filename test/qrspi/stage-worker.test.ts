import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { AgentHarnessPort } from "../../src/agent-harness"
import type { QrspiStorePort, StageOperationLease } from "../../src/qrspi/store"
import {
  BuiltInStageContracts,
  StageCatalog,
  StageContractInput,
  defaultQrspiWorkflowDefinition,
  makeQrspiHarnessDefinitions,
} from "../../src/qrspi/stages"
import { runStageProduceIterationWith } from "../../src/qrspi/stage-worker"
import type { QrspiWorkspacePort } from "../../src/qrspi/workspace"

const now = new Date("2026-07-22T12:00:00.000Z")
const readyTicket = {
  reference: {
    tracker: "beads" as const,
    trackerInstanceId: "workspace-42",
    nativeTicketId: "workflowd-vs3.4",
  },
  issueType: "feature" as const,
  title: "Pass the ticket to the producer",
  description: "The producer needs the authoritative product requirements.",
  sources: ["https://example.test/ticket"],
  acceptanceCriteria: ["The complete ready ticket is present in the stage input."],
  scenarios: [
    {
      name: "Authoritative context",
      given: "a ready ticket",
      when: "the producer starts",
      then: "the title, description, criteria, and scenarios are available",
      covers: [0],
    },
  ],
}
const lease: StageOperationLease = {
  operationId: "workflow:1:StageProduce:questions:1:1",
  operationRevision: 1,
  attempt: 1,
  leaseToken: "11111111-1111-4111-8111-111111111111",
  scope: { _tag: "GenerationScope", workflowId: "workflow", generation: 1 },
  input: {
    stageKey: "questions",
    stageKind: "document",
    stageRevision: 1,
    workflowDefinitionSha256: "a".repeat(64),
    ticketRevisionSha256: "b".repeat(64),
    sources: [],
  },
  stage: defaultQrspiWorkflowDefinition.stages[0]!,
  repository: {
    providerInstanceId: "github",
    repositoryId: "42",
    repositoryFullName: "owner/repo",
  },
  headRef: "feature/ticket",
  currentHeadSha: "c".repeat(40),
  ticketId: "workflowd-vs3.4",
  readyTicket,
}

function fixture(currentness: ReadonlyArray<boolean> = [true, true]) {
  const calls: string[] = []
  let check = 0
  const store: Pick<
    QrspiStorePort,
    | "claimStageOperation"
    | "isStageOperationCurrent"
    | "completeStageProduce"
    | "rescheduleStageOperation"
    | "recordStageAgentLaunchIntent"
    | "recordStageAgentSessionReference"
    | "requireStageSessionCleanup"
  > = {
    claimStageOperation: () => Effect.succeed(lease),
    isStageOperationCurrent: () => Effect.succeed(currentness[check++] ?? false),
    completeStageProduce: () =>
      Effect.sync(() => calls.push("complete")).pipe(Effect.as("completed" as const)),
    rescheduleStageOperation: () =>
      Effect.sync(() => calls.push("reschedule")).pipe(Effect.as("rescheduled" as const)),
    recordStageAgentLaunchIntent: () =>
      Effect.sync(() => calls.push("record-launch-intent")).pipe(Effect.as("recorded" as const)),
    recordStageAgentSessionReference: () =>
      Effect.sync(() => calls.push("record-session-reference")).pipe(
        Effect.as("recorded" as const),
      ),
    requireStageSessionCleanup: () =>
      Effect.sync(() => calls.push("require-cleanup")).pipe(Effect.as("waiting_human" as const)),
  }
  const harness: AgentHarnessPort = {
    validateAvailability: () => Effect.void,
    prepare: (definition, input, context) =>
      Schema.decodeUnknown(definition.inputSchema)(input).pipe(
        Effect.orDie,
        Effect.map((decoded) => ({
          launchIntent: {
            sessionReferenceId: "session-ref",
            harness: definition.ref,
            definitionHash: "d".repeat(64),
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
      ),
    createSession: (prepared) => {
      calls.push("create-session")
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
        createdAt: now.toISOString(),
        state: "created",
      })
    },
    resumeSession: (prepared) => {
      calls.push("resume-session")
      return Schema.decodeUnknown(prepared.outputSchema)({
        candidateSha: "e".repeat(40),
        content: "# Questions",
        summary: "No unanswered questions",
      }).pipe(Effect.orDie)
    },
    abortSession: () => Effect.void,
  }
  const definitions = makeQrspiHarnessDefinitions({
    agent: "qrspi-producer",
    model: "openai/gpt-5.6-sol",
    timeoutMs: 3_600_000,
  })
  const workspace: QrspiWorkspacePort = {
    withWorkspace: (input, use) => {
      calls.push(`workspace:${input.workflowId}:${input.targetSha}`)
      return use("/tmp/qrspi/workflow")
    },
  }
  return {
    calls,
    definitions,
    store,
    harness,
    workspace,
    catalog: new StageCatalog(BuiltInStageContracts),
  }
}

describe("StageProduce worker", () => {
  test("runs a generic retained stage with its trusted artifact destination", async () => {
    const fake = fixture()
    let contractInput: unknown
    let harnessInput: unknown
    let prompt = ""
    const customStage = {
      ...lease.stage,
      outputContract: {
        _tag: "Artifact" as const,
        pathTemplate: "product/specifications/{ticketId}/{stageKey}.adoc",
        mediaType: "text/asciidoc",
      },
    }
    const harness: AgentHarnessPort = {
      ...fake.harness,
      prepare: (definition, input, context) => {
        harnessInput = input
        prompt = definition.prompt(Schema.decodeUnknownSync(definition.inputSchema)(input))
        contractInput = Schema.decodeUnknownSync(Schema.Struct({ input: StageContractInput }))(
          input,
        ).input
        return fake.harness.prepare(definition, input, context)
      },
    }

    const result = await Effect.runPromise(
      runStageProduceIterationWith({
        workerId: "stage-worker",
        leaseDurationMs: 60_000,
        workspace: fake.workspace,
        harnessDefinitions: fake.definitions,
        now: () => now,
        randomId: () => lease.leaseToken,
        store: {
          ...fake.store,
          claimStageOperation: () => Effect.succeed({ ...lease, stage: customStage }),
        },
        harness,
        catalog: fake.catalog,
      }),
    )

    expect(result).toBe("completed")
    expect(fake.calls).toEqual([
      `workspace:workflow:${lease.currentHeadSha}`,
      "record-launch-intent",
      "create-session",
      "record-session-reference",
      "resume-session",
      "complete",
    ])
    expect(contractInput).toMatchObject({ readyTicket })
    expect(harnessInput).toMatchObject({
      expectedArtifact: {
        path: "product/specifications/workflowd-vs3.4/questions.adoc",
        mediaType: "text/asciidoc",
      },
    })
    expect(prompt).toContain("product/specifications/workflowd-vs3.4/questions.adoc")
    expect(prompt).toContain("text/asciidoc")
  })

  test("aborts and durably supersedes a recorded session before rescheduling", async () => {
    const fake = fixture()
    let rescheduleInput: unknown
    const result = await Effect.runPromise(
      runStageProduceIterationWith({
        workerId: "stage-worker",
        leaseDurationMs: 60_000,
        workspace: fake.workspace,
        harnessDefinitions: fake.definitions,
        now: () => now,
        randomId: () => lease.leaseToken,
        store: {
          ...fake.store,
          rescheduleStageOperation: (input) => {
            rescheduleInput = input
            fake.calls.push("reschedule")
            return Effect.succeed("rescheduled" as const)
          },
        },
        harness: {
          ...fake.harness,
          resumeSession: () =>
            Effect.sync(() => fake.calls.push("resume-session")).pipe(
              Effect.andThen(Effect.die(new Error("resume failed"))),
            ),
          abortSession: () =>
            Effect.sync(() => fake.calls.push("abort-session")).pipe(Effect.asVoid),
        },
        catalog: fake.catalog,
      }),
    )

    expect(result).toBe("rescheduled")
    expect(fake.calls).toEqual([
      `workspace:workflow:${lease.currentHeadSha}`,
      "record-launch-intent",
      "create-session",
      "record-session-reference",
      "resume-session",
      "abort-session",
      "reschedule",
    ])
    expect(rescheduleInput).toMatchObject({
      confirmedAbortedSessionReferenceId: "session-ref",
    })
  })

  test("retains fencing when recorded session cleanup is uncertain", async () => {
    const fake = fixture()
    const result = await Effect.runPromise(
      runStageProduceIterationWith({
        workerId: "stage-worker",
        leaseDurationMs: 60_000,
        workspace: fake.workspace,
        harnessDefinitions: fake.definitions,
        now: () => now,
        randomId: () => lease.leaseToken,
        store: fake.store,
        harness: {
          ...fake.harness,
          resumeSession: () => Effect.die(new Error("resume failed")),
          abortSession: () => Effect.die(new Error("abort uncertain")),
        },
        catalog: fake.catalog,
      }),
    )

    expect(result).toBe("waiting_human")
    expect(fake.calls).toContain("require-cleanup")
    expect(fake.calls).not.toContain("reschedule")
  })

  test("yields the post-agent currentness check before durable completion", async () => {
    const fake = fixture([true, false])

    const result = await Effect.runPromise(
      runStageProduceIterationWith({
        workerId: "stage-worker",
        leaseDurationMs: 60_000,
        workspace: fake.workspace,
        harnessDefinitions: fake.definitions,
        now: () => now,
        randomId: () => lease.leaseToken,
        store: fake.store,
        harness: fake.harness,
        catalog: fake.catalog,
      }),
    )

    expect(result).toBe("stale")
    expect(fake.calls).not.toContain("complete")
  })

  test("passes typed implementation progress and predecessor session context", async () => {
    const fake = fixture()
    let contractInput: unknown
    const harness: AgentHarnessPort = {
      ...fake.harness,
      prepare: (definition, input, context) => {
        contractInput = Schema.decodeUnknownSync(Schema.Struct({ input: StageContractInput }))(
          input,
        ).input
        return fake.harness.prepare(definition, input, context)
      },
    }
    const implementation = {
      ...lease,
      input: {
        ...lease.input,
        stageKey: "implementation",
        stageKind: "implementation" as const,
        stepPosition: 2,
      },
      stage: defaultQrspiWorkflowDefinition.stages[5]!,
      predecessorSessionReferenceId: "predecessor-session",
      implementationCommits: [
        {
          position: 1,
          commitSha: "d".repeat(40),
          parentSha: "c".repeat(40),
          changedPaths: ["src/one.ts"],
          operationId: "publish:1",
        },
      ],
    } satisfies StageOperationLease
    const store = {
      ...fake.store,
      claimStageOperation: () => Effect.succeed(implementation),
    }

    await Effect.runPromise(
      runStageProduceIterationWith({
        workerId: "stage-worker",
        leaseDurationMs: 3_700_000,
        workspace: fake.workspace,
        harnessDefinitions: fake.definitions,
        now: () => now,
        randomId: () => lease.leaseToken,
        store,
        harness,
        catalog: fake.catalog,
      }),
    )

    expect(contractInput).toMatchObject({
      stepPosition: 2,
      predecessorSessionReferenceId: "predecessor-session",
    })
    const decoded = Schema.decodeUnknownSync(StageContractInput)(contractInput)
    expect(decoded.implementationCommits?.[0]).toMatchObject({
      position: 1,
      commitSha: "d".repeat(40),
    })
  })
})

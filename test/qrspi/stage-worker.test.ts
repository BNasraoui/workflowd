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

const now = new Date("2026-07-22T12:00:00.000Z")
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
    | "recordStageAgentSession"
  > = {
    claimStageOperation: () => Effect.succeed(lease),
    isStageOperationCurrent: () => Effect.succeed(currentness[check++] ?? false),
    completeStageProduce: () =>
      Effect.sync(() => calls.push("complete")).pipe(Effect.as("completed" as const)),
    rescheduleStageOperation: () =>
      Effect.sync(() => calls.push("reschedule")).pipe(Effect.as("rescheduled" as const)),
    recordStageAgentSession: () =>
      Effect.sync(() => calls.push("record-session")).pipe(Effect.as("recorded" as const)),
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
  return { calls, definitions, store, harness, catalog: new StageCatalog(BuiltInStageContracts) }
}

describe("StageProduce worker", () => {
  test("runs a generic retained stage without invoking any pull-request API", async () => {
    const fake = fixture()

    const result = await Effect.runPromise(
      runStageProduceIterationWith({
        workerId: "stage-worker",
        leaseDurationMs: 60_000,
        directory: "/tmp/qrspi",
        harnessDefinitions: fake.definitions,
        now: () => now,
        randomId: () => lease.leaseToken,
        store: fake.store,
        harness: fake.harness,
        catalog: fake.catalog,
      }),
    )

    expect(result).toBe("completed")
    expect(fake.calls).toEqual(["create-session", "record-session", "resume-session", "complete"])
  })

  test("yields the post-agent currentness check before durable completion", async () => {
    const fake = fixture([true, false])

    const result = await Effect.runPromise(
      runStageProduceIterationWith({
        workerId: "stage-worker",
        leaseDurationMs: 60_000,
        directory: "/tmp/qrspi",
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
        directory: "/tmp/qrspi",
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

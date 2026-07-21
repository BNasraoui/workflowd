import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { runArtifactPublishIterationWith } from "../../src/qrspi/artifact-worker"
import { type ArtifactPublicationRepository } from "../../src/qrspi/artifact-publication"
import type { StageOperationLease } from "../../src/qrspi/store"
import { defaultQrspiWorkflowDefinition } from "../../src/qrspi/stages"
import type { QrspiWorkspacePort } from "../../src/qrspi/workspace"

const readyTicket = {
  reference: {
    tracker: "beads" as const,
    trackerInstanceId: "workspace-42",
    nativeTicketId: "workflowd-vs3.4",
  },
  issueType: "feature" as const,
  title: "Publish a QRSPI stage",
  description: "Publish each prepared stage result to its isolated ticket branch.",
  sources: ["https://example.test/ticket"],
  acceptanceCriteria: ["The result is published from the workflow worktree."],
  scenarios: [
    {
      name: "Publish",
      given: "a prepared result",
      when: "publication runs",
      then: "the ticket branch advances",
      covers: [0],
    },
  ],
}

const unusedStoreMethods = {
  findArtifactPublicationRecovery: () => Effect.succeed(null),
  claimStageOperation: () => Effect.die("unexpected claim"),
  isStageOperationCurrent: () => Effect.succeed(true),
  bindArtifactPublication: () => Effect.die("unexpected artifact bind"),
  completeArtifactPublication: () => Effect.die("unexpected artifact completion"),
  bindImplementationPublication: () => Effect.die("unexpected implementation bind"),
  completeImplementationPublication: () => Effect.die("unexpected implementation completion"),
  rescheduleStageOperation: () => Effect.die("unexpected reschedule"),
  recordArtifactPublicationOutcome: () => Effect.die("unexpected publication outcome"),
}

test("ArtifactPublish publishes the ticket branch directly and has no pull-request capability", async () => {
  const calls: string[] = []
  const finalSha = "f".repeat(40)
  const content = "# Questions"
  const work: StageOperationLease = {
    operationId: "publish:1",
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
    sessionReferenceId: "session-ref",
    preparedResult: { candidateSha: "d".repeat(40), content, summary: "Answered" },
  }
  const store = {
    ...unusedStoreMethods,
    findArtifactPublicationRecovery: () => Effect.succeed(null),
    claimStageOperation: () => Effect.succeed(work),
    isStageOperationCurrent: () => Effect.succeed(true),
    bindArtifactPublication: () => Effect.succeed("bound" as const),
    completeArtifactPublication: () =>
      Effect.sync(() => calls.push("complete")).pipe(Effect.as("completed" as const)),
    rescheduleStageOperation: () => Effect.die("must not reschedule"),
  }
  let remote = work.currentHeadSha
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: (input) => {
      calls.push("finalize")
      return Effect.succeed({
        finalSha,
        parentSha: input.expectedParentSha,
        artifact: {
          ...input.artifactIdentity,
          commitSha: finalSha,
          blobSha: "e".repeat(40),
          contentSha256: input.expectedContentSha256,
        },
      })
    },
    updateRefExact: () =>
      Effect.sync(() => {
        calls.push("update-ticket-ref")
        remote = finalSha
      }),
    observeRef: () => Effect.succeed(remote),
    advanceLocalWorktree: () => Effect.void,
  }
  const workspace: QrspiWorkspacePort = {
    withWorkspace: (input, use) => {
      calls.push(`workspace:${input.workflowId}:${input.targetSha}`)
      return use("/tmp/qrspi/workflow")
    },
  }

  const result = await Effect.runPromise(
    runArtifactPublishIterationWith({
      workerId: "publisher",
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      randomId: () => work.leaseToken,
      store,
      workspace,
      repositoryForDirectory: (directory) => {
        calls.push(`repository:${directory}`)
        return repository
      },
    }),
  )

  expect(result).toBe("Published")
  expect(calls).toEqual([
    `workspace:workflow:${"d".repeat(40)}`,
    "repository:/tmp/qrspi/workflow",
    "finalize",
    "update-ticket-ref",
    "complete",
  ])
  expect("createPullRequest" in repository).toBe(false)
  expect("updatePullRequest" in repository).toBe(false)
})

test("restart recovers a waiting_external publication from its durable SHA binding", async () => {
  const finalSha = "f".repeat(40)
  const artifact = {
    repository: {
      providerInstanceId: "github",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
    },
    workflowId: "workflow",
    generation: 1,
    stageKey: "questions",
    stageRevision: 1,
    commitSha: finalSha,
    path: "docs/qrspi/workflowd-vs3.4/01-questions.md",
    blobSha: "e".repeat(40),
    contentSha256: createHash("sha256").update("# Questions").digest("hex"),
    mediaType: "text/markdown",
  }
  const recovery = {
    operationId: "publish:1",
    operationRevision: 1,
    attempt: 1,
    leaseToken: "authoritative-recovery",
    scope: { _tag: "GenerationScope" as const, workflowId: "workflow", generation: 1 },
    input: {
      stageKey: "questions",
      stageKind: "document" as const,
      stageRevision: 1,
      workflowDefinitionSha256: "a".repeat(64),
      ticketRevisionSha256: "b".repeat(64),
      sources: [],
    },
    stage: defaultQrspiWorkflowDefinition.stages[0]!,
    repository: artifact.repository,
    headRef: "feature/ticket",
    currentHeadSha: "c".repeat(40),
    ticketId: "workflowd-vs3.4",
    readyTicket,
    sessionReferenceId: "session-ref",
    preparedResult: {
      candidateSha: "d".repeat(40),
      content: "# Questions",
      summary: "Answered",
    },
    bound: { finalSha, parentSha: "c".repeat(40), artifact },
  }
  let completed = false
  const store = {
    ...unusedStoreMethods,
    findArtifactPublicationRecovery: () => Effect.succeed(recovery),
    claimStageOperation: () => Effect.die("must not claim new work"),
    isStageOperationCurrent: () => Effect.succeed(true),
    completeArtifactPublication: () => {
      completed = true
      return Effect.succeed("completed" as const)
    },
    rescheduleStageOperation: () => Effect.die("must not reschedule"),
  }
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: () => Effect.die("must not sign another commit"),
    updateRefExact: () => Effect.void,
    observeRef: () => Effect.succeed(finalSha),
    advanceLocalWorktree: () => Effect.void,
  }

  const result = await Effect.runPromise(
    runArtifactPublishIterationWith({
      workerId: "restarted",
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      randomId: () => "11111111-1111-4111-8111-111111111111",
      store,
      repository,
    }),
  )

  expect(result).toBe("Published")
  expect(completed).toBe(true)
})

test("publishes an implementation commit as a durable checkpoint rather than a document artifact", async () => {
  const stage = defaultQrspiWorkflowDefinition.stages[5]!
  const work: StageOperationLease = {
    operationId: "implementation-publish:1",
    operationRevision: 1,
    attempt: 1,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    scope: { _tag: "GenerationScope", workflowId: "workflow", generation: 1 },
    input: {
      stageKey: "implementation",
      stageKind: "implementation",
      stageRevision: 1,
      workflowDefinitionSha256: "a".repeat(64),
      ticketRevisionSha256: "b".repeat(64),
      sources: [],
    },
    stage,
    repository: {
      providerInstanceId: "github",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
    },
    headRef: "feature/ticket",
    currentHeadSha: "c".repeat(40),
    ticketId: "workflowd-vs3.4",
    readyTicket,
    sessionReferenceId: "session-ref",
    preparedResult: {
      candidateSha: "d".repeat(40),
      changedPaths: ["src/change.ts"],
      final: true,
      deliveryEvidence: {
        summary: "Scenario passes",
        scenarios: [{ scenario: 0, evidence: "bun test passes" }],
      },
    },
  }
  let checkpoint: unknown
  const store = {
    ...unusedStoreMethods,
    findArtifactPublicationRecovery: () => Effect.succeed(null),
    claimStageOperation: () => Effect.succeed(work),
    isStageOperationCurrent: () => Effect.succeed(true),
    bindImplementationPublication: () => Effect.succeed("bound" as const),
    completeImplementationPublication: (input: { readonly checkpoint?: unknown }) => {
      checkpoint = input.checkpoint
      return Effect.succeed("completed" as const)
    },
  }
  let remote = work.currentHeadSha
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: () => Effect.die("must not use document publication"),
    finalizeImplementation: () =>
      Effect.succeed({ finalSha: "f".repeat(40), parentSha: work.currentHeadSha }),
    updateRefExact: (input) =>
      Effect.sync(() => {
        remote = input.newSha
      }),
    observeRef: () => Effect.succeed(remote),
    advanceLocalWorktree: () => Effect.void,
  }

  const result = await Effect.runPromise(
    runArtifactPublishIterationWith({
      workerId: "publisher",
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      randomId: () => work.leaseToken,
      store,
      repository,
    }),
  )

  expect(result).toBe("completed")
  expect(checkpoint).toMatchObject({
    checkpointId: "checkpoint:implementation-publish:1",
    baseSha: work.currentHeadSha,
    finalSha: "f".repeat(40),
    commits: [{ changedPaths: ["src/change.ts"] }],
  })
  expect(checkpoint).not.toHaveProperty("path")
})

test("durably binds the final implementation SHA before advancing local HEAD", async () => {
  const work: StageOperationLease = {
    operationId: "implementation-publish:crash",
    operationRevision: 1,
    attempt: 1,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    scope: { _tag: "GenerationScope", workflowId: "workflow", generation: 1 },
    input: {
      stageKey: "implementation",
      stageKind: "implementation",
      stageRevision: 1,
      workflowDefinitionSha256: "a".repeat(64),
      ticketRevisionSha256: "b".repeat(64),
      sources: [],
    },
    stage: defaultQrspiWorkflowDefinition.stages[5]!,
    repository: {
      providerInstanceId: "github",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
    },
    headRef: "feature/ticket",
    currentHeadSha: "c".repeat(40),
    ticketId: "workflowd-vs3.4",
    readyTicket,
    sessionReferenceId: "session-ref",
    preparedResult: {
      candidateSha: "d".repeat(40),
      changedPaths: ["src/change.ts"],
      final: false,
    },
  }
  const calls: string[] = []
  const store = {
    ...unusedStoreMethods,
    claimStageOperation: () => Effect.succeed(work),
    bindImplementationPublication: () =>
      Effect.sync(() => calls.push("bind")).pipe(Effect.as("bound" as const)),
  }
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: () => Effect.die("unexpected document publication"),
    finalizeImplementation: () =>
      Effect.succeed({ finalSha: "f".repeat(40), parentSha: work.currentHeadSha }),
    advanceLocalWorktree: () =>
      Effect.sync(() => calls.push("advance-local")).pipe(
        Effect.andThen(Effect.fail(new Error("process stopped after local advance"))),
      ),
    updateRefExact: () => Effect.die("must not update remote"),
    observeRef: () => Effect.die("must not observe remote"),
  }

  await expect(
    Effect.runPromise(
      runArtifactPublishIterationWith({
        workerId: "publisher",
        leaseDurationMs: 60_000,
        now: () => new Date("2026-07-22T12:00:00.000Z"),
        randomId: () => work.leaseToken,
        store,
        repository,
      }),
    ),
  ).rejects.toThrow("process stopped")
  expect(calls).toEqual(["bind", "advance-local"])
})

test("publishes a non-final implementation step without requiring delivery evidence", async () => {
  const stage = defaultQrspiWorkflowDefinition.stages[5]!
  const work: StageOperationLease = {
    operationId: "implementation-publish:1",
    operationRevision: 1,
    attempt: 1,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    scope: { _tag: "GenerationScope", workflowId: "workflow", generation: 1 },
    input: {
      stageKey: "implementation",
      stageKind: "implementation",
      stageRevision: 1,
      workflowDefinitionSha256: "a".repeat(64),
      ticketRevisionSha256: "b".repeat(64),
      sources: [],
    },
    stage,
    repository: {
      providerInstanceId: "github",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
    },
    headRef: "feature/ticket",
    currentHeadSha: "c".repeat(40),
    ticketId: "workflowd-vs3.4",
    readyTicket,
    sessionReferenceId: "session-ref",
    preparedResult: {
      candidateSha: "d".repeat(40),
      changedPaths: ["src/change.ts"],
      final: false,
    },
  }
  let completion: unknown
  const store = {
    ...unusedStoreMethods,
    claimStageOperation: () => Effect.succeed(work),
    bindImplementationPublication: () => Effect.succeed("bound" as const),
    completeImplementationPublication: (input: unknown) => {
      completion = input
      return Effect.succeed("completed" as const)
    },
  }
  let remote = work.currentHeadSha
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: () => Effect.die("must not use document publication"),
    finalizeImplementation: () =>
      Effect.succeed({ finalSha: "f".repeat(40), parentSha: work.currentHeadSha }),
    updateRefExact: ({ newSha }) => Effect.sync(() => void (remote = newSha)),
    observeRef: () => Effect.succeed(remote),
    advanceLocalWorktree: () => Effect.void,
  }

  await expect(
    Effect.runPromise(
      runArtifactPublishIterationWith({
        workerId: "publisher",
        leaseDurationMs: 60_000,
        now: () => new Date("2026-07-22T12:00:00.000Z"),
        randomId: () => work.leaseToken,
        store,
        repository,
      }),
    ),
  ).resolves.toBe("completed")
  expect(completion).not.toHaveProperty("checkpoint")
})

test("rejects a final implementation result without delivery evidence before repository mutation", async () => {
  const work = {
    operationId: "implementation-publish:final",
    operationRevision: 1,
    attempt: 1,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    scope: { _tag: "GenerationScope" as const, workflowId: "workflow", generation: 1 },
    input: {
      stageKey: "implementation",
      stageKind: "implementation" as const,
      stageRevision: 1,
      workflowDefinitionSha256: "a".repeat(64),
      ticketRevisionSha256: "b".repeat(64),
      sources: [],
    },
    stage: defaultQrspiWorkflowDefinition.stages[5]!,
    repository: {
      providerInstanceId: "github",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
    },
    headRef: "feature/ticket",
    currentHeadSha: "c".repeat(40),
    ticketId: "workflowd-vs3.4",
    readyTicket,
    sessionReferenceId: "session-ref",
    preparedResult: {
      candidateSha: "d".repeat(40),
      changedPaths: ["src/change.ts"],
      final: true,
    },
  } satisfies StageOperationLease
  let mutated = false
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: () => Effect.die("unexpected document publication"),
    finalizeImplementation: () => Effect.sync(() => void (mutated = true)).pipe(Effect.die),
    updateRefExact: () => Effect.die("unexpected ref update"),
    observeRef: () => Effect.die("unexpected observation"),
    advanceLocalWorktree: () => Effect.die("unexpected local advance"),
  }

  await expect(
    Effect.runPromise(
      runArtifactPublishIterationWith({
        workerId: "publisher",
        leaseDurationMs: 60_000,
        now: () => new Date("2026-07-22T12:00:00.000Z"),
        randomId: () => work.leaseToken,
        store: { ...unusedStoreMethods, claimStageOperation: () => Effect.succeed(work) },
        repository,
      }),
    ),
  ).rejects.toThrow("final delivery evidence")
  expect(mutated).toBe(false)
})

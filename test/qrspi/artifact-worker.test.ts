import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { runArtifactPublishIterationWith } from "../../src/qrspi/artifact-worker"
import {
  type ArtifactPublicationRepository,
  GitArtifactPublicationRepository,
} from "../../src/qrspi/artifact-publication"
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
  recordStaleArtifactPublicationEffect: () => Effect.die("unexpected stale publication effect"),
}

test("ArtifactPublish publishes the ticket branch directly and has no pull-request capability", async () => {
  const calls: string[] = []
  const finalSha = "f".repeat(40)
  const content = "# Questions"
  const work: StageOperationLease = {
    controllerId: "11111111-2222-4333-8444-555555555555",
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
  let trustedTrailers: ReadonlyArray<readonly [string, string]> = []
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: (input) => {
      calls.push("finalize")
      trustedTrailers = input.trustedTrailers
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
  expect(trustedTrailers).toContainEqual([
    "Workflowd-Job",
    "11111111-2222-4333-8444-555555555555:publish:1",
  ])
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
    controllerId: "11111111-2222-4333-8444-555555555555",
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
  const commands: ReadonlyArray<string>[] = []
  const repository = new GitArtifactPublicationRepository(
    "/tmp/qrspi/workflow",
    "1".repeat(40),
    "https://github.com/owner/repo.git",
    {
      run: (_operation, command) => {
        commands.push(command)
        const args = command.slice(1)
        if (args[0] === "rev-parse" && args[1] === "HEAD") return Effect.succeed(finalSha)
        if (args[0] === "ls-remote") {
          return Effect.succeed(`${finalSha}\trefs/heads/feature/ticket`)
        }
        return Effect.die(`Unexpected git command: ${args.join(" ")}`)
      },
      runBytes: () => Effect.die("must not read or sign another commit"),
    },
  )

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
  expect(commands.filter((command) => command[1] === "ls-remote")).toHaveLength(2)
  expect(commands.some((command) => command[1] === "push")).toBe(false)
})

test("records a stale document publication effect for reconciliation", async () => {
  const finalSha = "f".repeat(40)
  const content = "# Questions"
  const work: StageOperationLease = {
    controllerId: "11111111-2222-4333-8444-555555555555",
    operationId: "publish:stale-document",
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
  let currentChecks = 0
  let staleEffect: unknown
  const store = {
    ...unusedStoreMethods,
    claimStageOperation: () => Effect.succeed(work),
    isStageOperationCurrent: () => Effect.succeed(++currentChecks < 3),
    bindArtifactPublication: () => Effect.succeed("bound" as const),
    recordStaleArtifactPublicationEffect: (input: unknown) => {
      staleEffect = input
      return Effect.succeed("reconciling" as const)
    },
  }
  let remote = work.currentHeadSha
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: (input) =>
      Effect.succeed({
        finalSha,
        parentSha: input.expectedParentSha,
        artifact: {
          ...input.artifactIdentity,
          commitSha: finalSha,
          blobSha: "e".repeat(40),
          contentSha256: input.expectedContentSha256,
        },
      }),
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
  ).resolves.toBe("reconciling")
  expect(staleEffect).toMatchObject({
    operationId: work.operationId,
    expectedOld: work.currentHeadSha,
    finalSha,
    observedHeadSha: finalSha,
  })
})

test("publishes an implementation commit as a durable checkpoint rather than a document artifact", async () => {
  const stage = defaultQrspiWorkflowDefinition.stages[5]!
  const work: StageOperationLease = {
    controllerId: "11111111-2222-4333-8444-555555555555",
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

test("records a stale implementation publication effect for reconciliation", async () => {
  const finalSha = "f".repeat(40)
  const work: StageOperationLease = {
    controllerId: "11111111-2222-4333-8444-555555555555",
    operationId: "implementation-publish:stale",
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
  let currentChecks = 0
  let staleEffect: unknown
  const store = {
    ...unusedStoreMethods,
    claimStageOperation: () => Effect.succeed(work),
    isStageOperationCurrent: () => Effect.succeed(++currentChecks < 2),
    bindImplementationPublication: () => Effect.succeed("bound" as const),
    recordStaleArtifactPublicationEffect: (input: unknown) => {
      staleEffect = input
      return Effect.succeed("reconciling" as const)
    },
  }
  let remote = work.currentHeadSha
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: () => Effect.die("must not use document publication"),
    finalizeImplementation: () => Effect.succeed({ finalSha, parentSha: work.currentHeadSha }),
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
  ).resolves.toBe("reconciling")
  expect(staleEffect).toMatchObject({
    operationId: work.operationId,
    expectedOld: work.currentHeadSha,
    finalSha,
    observedHeadSha: finalSha,
  })
})

test("durably binds the final implementation SHA before advancing local HEAD", async () => {
  const work: StageOperationLease = {
    controllerId: "11111111-2222-4333-8444-555555555555",
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
    controllerId: "11111111-2222-4333-8444-555555555555",
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

test.each([
  ["without delivery evidence", readyTicket, undefined],
  [
    "with out-of-range scenario evidence",
    readyTicket,
    { summary: "Invalid scenario", scenarios: [{ scenario: 999, evidence: "not linked" }] },
  ],
  [
    "without evidence for every ticket scenario",
    {
      ...readyTicket,
      scenarios: [
        ...readyTicket.scenarios,
        { name: "Verify", given: "a change", when: "tests run", then: "they pass", covers: [0] },
      ],
    },
    { summary: "Incomplete", scenarios: [{ scenario: 0, evidence: "one scenario" }] },
  ],
] as const)(
  "reschedules a final implementation result %s before repository mutation",
  async (_case, ticket, deliveryEvidence) => {
    const work = {
      controllerId: "11111111-2222-4333-8444-555555555555",
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
      readyTicket: ticket,
      sessionReferenceId: "session-ref",
      preparedResult: {
        candidateSha: "d".repeat(40),
        changedPaths: ["src/change.ts"],
        final: true,
        ...(deliveryEvidence === undefined ? {} : { deliveryEvidence }),
      },
    } satisfies StageOperationLease
    let mutated = false
    let rescheduled:
      { readonly runAt: Date; readonly now: Date; readonly error: string } | undefined
    const repository: ArtifactPublicationRepository = {
      finalizeDocument: () => Effect.die("unexpected document publication"),
      finalizeImplementation: () => Effect.sync(() => void (mutated = true)).pipe(Effect.die),
      updateRefExact: () => Effect.die("unexpected ref update"),
      observeRef: () => Effect.die("unexpected observation"),
      advanceLocalWorktree: () => Effect.die("unexpected local advance"),
    }

    await Effect.runPromise(
      runArtifactPublishIterationWith({
        workerId: "publisher",
        leaseDurationMs: 60_000,
        now: () => new Date("2026-07-22T12:00:00.000Z"),
        randomId: () => work.leaseToken,
        store: {
          ...unusedStoreMethods,
          claimStageOperation: () => Effect.succeed(work),
          rescheduleStageOperation: (input) => {
            rescheduled = input
            return Effect.succeed("rescheduled" as const)
          },
        },
        repository,
      }),
    )
    expect(mutated).toBe(false)
    expect(rescheduled?.runAt).toEqual(new Date("2026-07-22T12:00:01.000Z"))
    expect(rescheduled?.now).toEqual(new Date("2026-07-22T12:00:00.000Z"))
    expect(rescheduled?.error).toBeTruthy()
  },
)

test("reschedules an over-bound cumulative checkpoint before binding or updating refs", async () => {
  const calls: string[] = []
  const work = {
    controllerId: "11111111-2222-4333-8444-555555555555",
    operationId: "implementation-publish:over-bound",
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
    implementationCommits: [
      {
        position: 1,
        commitSha: "d".repeat(40),
        parentSha: "c".repeat(40),
        changedPaths: Array.from({ length: 10_000 }, (_, index) => `src/prior-${index}.ts`),
        operationId: "implementation-publish:prior",
      },
    ],
    preparedResult: {
      candidateSha: "e".repeat(40),
      changedPaths: ["src/new.ts"],
      final: true,
      deliveryEvidence: {
        summary: "Scenario passes",
        scenarios: [{ scenario: 0, evidence: "bun test passes" }],
      },
    },
  } satisfies StageOperationLease
  const store = {
    ...unusedStoreMethods,
    claimStageOperation: () => Effect.succeed(work),
    bindImplementationPublication: () =>
      Effect.sync(() => calls.push("bind")).pipe(Effect.as("bound" as const)),
    rescheduleStageOperation: () =>
      Effect.sync(() => calls.push("reschedule")).pipe(Effect.as("rescheduled" as const)),
  }
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: () => Effect.die("unexpected document publication"),
    finalizeImplementation: () =>
      Effect.sync(() => calls.push("finalize")).pipe(
        Effect.as({ finalSha: "f".repeat(40), parentSha: work.currentHeadSha }),
      ),
    advanceLocalWorktree: () => Effect.sync(() => calls.push("advance-local")),
    updateRefExact: () => Effect.sync(() => calls.push("update-ref")),
    observeRef: () => Effect.sync(() => calls.push("observe-ref")).pipe(Effect.as("f".repeat(40))),
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
  ).resolves.toBe("rescheduled")
  expect(calls).toEqual(["finalize", "reschedule"])
})

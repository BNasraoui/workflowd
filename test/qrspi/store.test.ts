import { expect, test } from "bun:test"
import { Effect } from "effect"
import { canonicalSha256 } from "../../src/qrspi/domain"
import { preflightDocumentStageRevisionAggregate } from "../../src/qrspi/store"
import type { DocumentStageRevisionAggregate } from "../../src/qrspi/stage-runtime"

const sha = (character: string) => character.repeat(64)
const repository = {
  providerInstanceId: "github-app-1",
  repositoryId: "repository-1",
  repositoryFullName: "owner/repository",
}

function documentAggregate(): DocumentStageRevisionAggregate {
  const sources = {
    workflowId: "workflow-1",
    generation: 1,
    stageKey: "plan",
    runOrdinal: 2,
    stageRevision: 3,
    workflowDefinitionSha256: sha("a"),
    stageDefinitionSha256: sha("b"),
    ticketRevision: {
      workflowId: "workflow-1",
      ticketRevisionSha256: sha("c"),
    },
    sources: [],
    sourceSetSha256: canonicalSha256([]),
    target: {
      repository,
      headRef: "refs/heads/workflow",
      expectedParentSha: "d".repeat(40),
    },
  }
  const revision = {
    workflowId: sources.workflowId,
    generation: sources.generation,
    stageKey: sources.stageKey,
    runOrdinal: sources.runOrdinal,
    stageRevision: sources.stageRevision,
  }
  const preparedValue = { _tag: "Document" as const, text: "# Plan" }

  return {
    kind: "document",
    sources,
    runState: "waiting_review",
    revisionState: "reviewing",
    ownerCrossingKey: "plan-publication",
    pendingRevision: revision,
    publishedRevision: revision,
    acceptedRevision: revision,
    preparedResult: {
      value: preparedValue,
      sha256: canonicalSha256(preparedValue),
    },
    finalArtifact: {
      repository,
      workflowId: sources.workflowId,
      generation: sources.generation,
      stageKey: sources.stageKey,
      stageRevision: sources.stageRevision,
      commitSha: "e".repeat(40),
      path: "artifacts/plan.md",
      blobSha: "f".repeat(40),
      contentSha256: sha("1"),
      mediaType: "text/markdown",
    },
    producerOperationId: "operation-produce-1",
    publicationOperationId: "operation-publish-1",
  }
}

const preflightFailure = (input: unknown) =>
  Effect.runPromise(preflightDocumentStageRevisionAggregate(input).pipe(Effect.either))

test("accepts one exact document aggregate", async () => {
  const aggregate = documentAggregate()

  await expect(
    Effect.runPromise(preflightDocumentStageRevisionAggregate(aggregate)),
  ).resolves.toEqual(aggregate)
})

test("rejects a malformed aggregate tag", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({ ...aggregate, kind: "implementation" })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "malformed",
    },
  })
})

test("rejects an unhashable prepared Document as malformed", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    preparedResult: {
      value: { _tag: "Document", text: "\ud800" },
      sha256: sha("2"),
    },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "QrspiStoreDataError", reason: "malformed" },
  })
})

test("bounds malformed structural diagnostics", async () => {
  const result = await preflightFailure({
    ...documentAggregate(),
    rejected: "x".repeat(10_000),
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "QrspiStoreDataError", reason: "malformed" },
  })
  if (result._tag === "Left") {
    expect(result.left.message.length).toBeGreaterThan(0)
    expect(result.left.message.length).toBeLessThanOrEqual(2_000)
  }
})

test("rejects a guarded pointer from another run", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    pendingRevision: {
      ...aggregate.pendingRevision!,
      runOrdinal: aggregate.sources.runOrdinal + 1,
    },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "identity_mismatch",
      expectedIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        runOrdinal: aggregate.sources.runOrdinal,
      },
      actualIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        runOrdinal: aggregate.sources.runOrdinal + 1,
      },
    },
  })
})

test("rejects a final artifact from another stage revision", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    finalArtifact: {
      ...aggregate.finalArtifact!,
      stageRevision: aggregate.sources.stageRevision + 1,
    },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "identity_mismatch",
      expectedIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        stageRevision: aggregate.sources.stageRevision,
        repository,
      },
      actualIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        stageRevision: aggregate.sources.stageRevision + 1,
        repository,
      },
    },
  })
})

test("rejects equal producer and publication operation IDs", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    publicationOperationId: aggregate.producerOperationId,
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "duplicate",
    },
  })
})

test("rejects a prepared Document with the wrong canonical hash", async () => {
  const aggregate = documentAggregate()
  const expectedSha256 = canonicalSha256(aggregate.preparedResult!.value)
  const result = await preflightFailure({
    ...aggregate,
    preparedResult: { ...aggregate.preparedResult!, sha256: sha("2") },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "hash_mismatch",
      expectedSha256,
      actualSha256: sha("2"),
    },
  })
})

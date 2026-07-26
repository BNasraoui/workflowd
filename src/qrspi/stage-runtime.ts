import { Effect, Schema } from "effect"
import {
  ArtifactReference,
  ExactStageScope,
  ExactStageSources,
  PreparedStageOutput,
} from "./contracts"
import { BoundedText, Sha256, canonicalSha256 } from "./domain"

export const StageRunIdentity = Schema.Struct({
  workflowId: ExactStageScope.fields.workflowId,
  generation: ExactStageScope.fields.generation,
  stageKey: ExactStageScope.fields.stageKey,
  runOrdinal: ExactStageScope.fields.runOrdinal,
})
export type StageRunIdentity = typeof StageRunIdentity.Type

export const StageRevisionIdentity = Schema.Struct({
  ...StageRunIdentity.fields,
  stageRevision: ExactStageScope.fields.stageRevision,
})
export type StageRevisionIdentity = typeof StageRevisionIdentity.Type

export const StageRunState = Schema.Literal(
  "blocked",
  "active",
  "waiting_review",
  "waiting_human",
  "waiting_ticket",
  "succeeded",
  "skipped",
  "rejected",
  "failed",
  "cancelled",
  "superseded",
  "data_error",
)

export const StageRevisionState = Schema.Literal(
  "producing",
  "publishing",
  "reviewing",
  "waiting_human",
  "accepted",
  "abandoned",
  "failed",
  "superseded",
)

type PreparedDocumentOutput = Extract<
  typeof PreparedStageOutput.Type,
  { readonly _tag: "Document" }
>
const PreparedDocumentOutput = PreparedStageOutput.pipe(
  Schema.filter((value): value is PreparedDocumentOutput => value._tag === "Document"),
)
const PreparedDocumentResult = Schema.Struct({ value: PreparedDocumentOutput, sha256: Sha256 })

const DocumentStageRevisionAggregateStructure = Schema.Struct({
  kind: Schema.Literal("document"),
  sources: ExactStageSources,
  runState: StageRunState,
  revisionState: StageRevisionState,
  ownerCrossingKey: BoundedText(512),
  pendingRevision: Schema.NullOr(StageRevisionIdentity),
  publishedRevision: Schema.NullOr(StageRevisionIdentity),
  acceptedRevision: Schema.NullOr(StageRevisionIdentity),
  preparedResult: Schema.optional(PreparedDocumentResult),
  finalArtifact: Schema.optional(ArtifactReference),
  producerOperationId: BoundedText(512),
  publicationOperationId: BoundedText(512),
})
type AggregateStructure = typeof DocumentStageRevisionAggregateStructure.Type

export const stageScopeFrom = (
  sources: typeof ExactStageSources.Type,
): typeof ExactStageScope.Type => ({
  workflowId: sources.workflowId,
  generation: sources.generation,
  stageKey: sources.stageKey,
  runOrdinal: sources.runOrdinal,
  stageRevision: sources.stageRevision,
  workflowDefinitionSha256: sources.workflowDefinitionSha256,
  stageDefinitionSha256: sources.stageDefinitionSha256,
})

export const stageRunIdentityFrom = (
  source: typeof ExactStageSources.Type | StageRevisionIdentity,
): StageRunIdentity => ({
  workflowId: source.workflowId,
  generation: source.generation,
  stageKey: source.stageKey,
  runOrdinal: source.runOrdinal,
})

export const stageRevisionIdentityFrom = (
  sources: typeof ExactStageSources.Type,
): StageRevisionIdentity => ({
  ...stageRunIdentityFrom(sources),
  stageRevision: sources.stageRevision,
})

export type DocumentAggregateIdentity = {
  readonly workflowId: ExactStageScope["workflowId"]
  readonly generation: ExactStageScope["generation"]
  readonly stageKey: ExactStageScope["stageKey"]
  readonly runOrdinal?: ExactStageScope["runOrdinal"]
  readonly stageRevision?: ExactStageScope["stageRevision"]
  readonly repository?: ArtifactReference["repository"]
}

type AggregateMismatch = {
  readonly reason: "malformed" | "duplicate" | "identity_mismatch" | "hash_mismatch"
  readonly message: string
  readonly expectedIdentity?: DocumentAggregateIdentity
  readonly actualIdentity?: DocumentAggregateIdentity
  readonly expectedSha256?: string
  readonly actualSha256?: string
}

const sameRun = (expected: StageRunIdentity, actual: StageRunIdentity) =>
  expected.workflowId === actual.workflowId &&
  expected.generation === actual.generation &&
  expected.stageKey === actual.stageKey &&
  expected.runOrdinal === actual.runOrdinal

function aggregateMismatch(value: AggregateStructure): AggregateMismatch | undefined {
  const expectedRun = stageRunIdentityFrom(value.sources)
  const crossRunPointer = [
    value.pendingRevision,
    value.publishedRevision,
    value.acceptedRevision,
  ].find((pointer) => pointer !== null && !sameRun(expectedRun, pointer))
  if (crossRunPointer !== undefined && crossRunPointer !== null) {
    return {
      reason: "identity_mismatch",
      message: "guarded revision pointer does not identify the aggregate run",
      expectedIdentity: expectedRun,
      actualIdentity: stageRunIdentityFrom(crossRunPointer),
    }
  }

  const artifact = value.finalArtifact
  if (
    artifact !== undefined &&
    (artifact.workflowId !== value.sources.workflowId ||
      artifact.generation !== value.sources.generation ||
      artifact.stageKey !== value.sources.stageKey ||
      artifact.stageRevision !== value.sources.stageRevision ||
      artifact.repository.providerInstanceId !==
        value.sources.target.repository.providerInstanceId ||
      artifact.repository.repositoryId !== value.sources.target.repository.repositoryId)
  ) {
    return {
      reason: "identity_mismatch",
      message: "final artifact does not identify the aggregate revision and repository",
      expectedIdentity: {
        workflowId: value.sources.workflowId,
        generation: value.sources.generation,
        stageKey: value.sources.stageKey,
        stageRevision: value.sources.stageRevision,
        repository: value.sources.target.repository,
      },
      actualIdentity: {
        workflowId: artifact.workflowId,
        generation: artifact.generation,
        stageKey: artifact.stageKey,
        stageRevision: artifact.stageRevision,
        repository: artifact.repository,
      },
    }
  }

  if (value.producerOperationId === value.publicationOperationId) {
    return {
      reason: "duplicate",
      message: "producer and publication operation IDs must differ",
    }
  }

  if (value.preparedResult !== undefined) {
    let expectedSha256: string
    try {
      expectedSha256 = canonicalSha256(value.preparedResult.value)
    } catch (cause) {
      return { reason: "malformed", message: String(cause).slice(0, 2_000) }
    }
    if (expectedSha256 !== value.preparedResult.sha256) {
      return {
        reason: "hash_mismatch",
        message: "prepared Document hash does not match its canonical value",
        expectedSha256,
        actualSha256: value.preparedResult.sha256,
      }
    }
  }
  return undefined
}

export const DocumentStageRevisionAggregate = DocumentStageRevisionAggregateStructure.pipe(
  Schema.filter((value) => aggregateMismatch(value)?.message ?? true),
)
export type DocumentStageRevisionAggregate = typeof DocumentStageRevisionAggregate.Type

export type DocumentAggregateDecodeIssue = {
  readonly recordId: string
  readonly message: string
  readonly details: AggregateMismatch | { readonly reason: "malformed" }
}

const revisionRecordId = (value: AggregateStructure) =>
  `${value.sources.workflowId}/${value.sources.generation}/${value.sources.stageKey}/${value.sources.runOrdinal}/${value.sources.stageRevision}`

export const decodeDocumentStageRevisionAggregate = (
  input: unknown,
): Effect.Effect<DocumentStageRevisionAggregate, DocumentAggregateDecodeIssue> =>
  Schema.decodeUnknown(DocumentStageRevisionAggregateStructure, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError((cause) => ({
      recordId: "unreadable-document-stage-revision-aggregate",
      message: String(cause),
      details: { reason: "malformed" as const },
    })),
    Effect.flatMap((value) => {
      const mismatch = aggregateMismatch(value)
      return mismatch === undefined
        ? Effect.succeed(value)
        : Effect.fail({
            recordId: revisionRecordId(value),
            message: mismatch.message,
            details: mismatch,
          })
    }),
  )

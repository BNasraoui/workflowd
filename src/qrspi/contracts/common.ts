import { createHash } from "node:crypto"
import { Data, Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../../json"
import {
  BoundedText,
  GitSha,
  PositiveVersion,
  PolicyReference,
  RepositoryReference,
  Sha256,
  StageContractRef,
  StageDefinition,
  WorkflowStartOutput,
  canonicalSha256,
} from "../domain"

export const MAX_DOCUMENT_RESULT_BYTES = 256 * 1024
export const MAX_STAGE_SOURCE_BYTES = 32 * 1024
export const MAX_EXACT_STAGE_SOURCES_BYTES = 24 * 1024
export const MAX_TASK_TITLE_BYTES = 256
export const MAX_TASK_PROMPT_BYTES = 4 * 1024

export const boundedUtf8 = (maximumBytes: number, name: string) =>
  Schema.String.pipe(
    Schema.filter((value) =>
      Buffer.byteLength(value, "utf8") <= maximumBytes
        ? true
        : `${name} exceeds ${maximumBytes} UTF-8 bytes`,
    ),
  )

export const BoundedMarkdown = (maximumBytes: number) => boundedUtf8(maximumBytes, "Markdown")

export const WorkflowId = WorkflowStartOutput.fields.workflowId
export const StageKey = StageDefinition.fields.key
export const Generation = WorkflowStartOutput.fields.generation

export const ExactStageScope = Schema.Struct({
  workflowId: WorkflowId,
  generation: Generation,
  stageKey: StageKey,
  runOrdinal: PositiveVersion,
  stageRevision: PositiveVersion,
  workflowDefinitionSha256: Sha256,
  stageDefinitionSha256: Sha256,
})
export type ExactStageScope = typeof ExactStageScope.Type

export const TicketRevisionReference = Schema.Struct({
  workflowId: WorkflowId,
  ticketRevisionSha256: Sha256,
})
export type TicketRevisionReference = typeof TicketRevisionReference.Type

export const RepositoryTarget = Schema.Struct({
  repository: RepositoryReference,
  headRef: BoundedText(256),
  expectedParentSha: GitSha,
})
export type RepositoryTarget = typeof RepositoryTarget.Type

export const RevisionIntent = Schema.Struct({ reason: BoundedText(2_000) })
export type RevisionIntent = typeof RevisionIntent.Type

export const DesignAcceptancePackageReference = Schema.Struct({
  workflowId: WorkflowId,
  generation: Generation,
  designStageRevision: PositiveVersion,
  packageSha256: Sha256,
})

export const DesignGateResponseReference = Schema.Struct({
  workflowId: WorkflowId,
  generation: Generation,
  designStageRevision: PositiveVersion,
  packageSha256: Sha256,
  responseSha256: Sha256,
})

export const ProvenancePromotionResultReference = Schema.Struct({
  workflowId: WorkflowId,
  generation: Generation,
  designStageRevision: PositiveVersion,
  packageSha256: Sha256,
  gateResponseSha256: Sha256,
  resultSha256: Sha256,
})

export const GraphReference = Schema.Struct({
  repository: RepositoryReference,
  workflowId: WorkflowId,
  generation: Generation,
  commitSha: GitSha,
  scope: BoundedText(256),
  graphSha256: Sha256,
})

export const StructureAuthority = Schema.Struct({
  acceptancePackage: DesignAcceptancePackageReference,
  gateResponse: DesignGateResponseReference,
  promotionResult: ProvenancePromotionResultReference,
  graph: GraphReference,
}).pipe(
  Schema.filter((authority) =>
    authority.acceptancePackage.workflowId === authority.gateResponse.workflowId &&
    authority.acceptancePackage.workflowId === authority.promotionResult.workflowId &&
    authority.acceptancePackage.workflowId === authority.graph.workflowId &&
    authority.acceptancePackage.generation === authority.gateResponse.generation &&
    authority.acceptancePackage.generation === authority.promotionResult.generation &&
    authority.acceptancePackage.generation === authority.graph.generation &&
    authority.acceptancePackage.designStageRevision ===
      authority.gateResponse.designStageRevision &&
    authority.acceptancePackage.designStageRevision ===
      authority.promotionResult.designStageRevision &&
    authority.acceptancePackage.packageSha256 === authority.gateResponse.packageSha256 &&
    authority.acceptancePackage.packageSha256 === authority.promotionResult.packageSha256 &&
    authority.gateResponse.responseSha256 === authority.promotionResult.gateResponseSha256
      ? true
      : "Structure authority references do not identify one accepted Design result",
  ),
)
export type StructureAuthority = typeof StructureAuthority.Type

export const exactPolicyReference = (expected: typeof PolicyReference.Type) =>
  PolicyReference.pipe(
    Schema.filter((actual) =>
      actual.name === expected.name && actual.version === expected.version
        ? true
        : `Expected ${expected.name}@${expected.version}`,
    ),
  )

export function isOrderedRoleSubsequence(
  actual: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
): boolean {
  let next = 0
  for (const role of actual) {
    const index = allowed.indexOf(role, next)
    if (index < 0) return false
    next = index + 1
  }
  return true
}

export const StageSourceRole = Schema.Literal(
  "Questions",
  "Research",
  "Design",
  "Structure",
  "Plan",
  "Implementation",
)
export type StageSourceRole = typeof StageSourceRole.Type

export const RepositoryRelativePath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(512),
  Schema.filter((path) => path === path.normalize("NFC")),
  Schema.filter(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
)
export const BoundedMediaType = Schema.String.pipe(
  Schema.pattern(new RegExp("^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,127}$")),
)

export const ArtifactReference = Schema.Struct({
  repository: RepositoryReference,
  workflowId: WorkflowId,
  generation: Generation,
  stageKey: StageKey,
  stageRevision: PositiveVersion,
  commitSha: GitSha,
  path: RepositoryRelativePath,
  blobSha: GitSha,
  contentSha256: Sha256,
  mediaType: BoundedMediaType,
})
export type ArtifactReference = typeof ArtifactReference.Type

const AcceptedPredecessorPointerBase = Schema.Struct({
  role: StageSourceRole,
  snapshotSha256: Sha256,
  runOrdinal: PositiveVersion,
  acceptedStageRevision: PositiveVersion,
  targetParentSha: GitSha,
  contract: StageContractRef,
  contractRegistrationSha256: Sha256,
  artifact: ArtifactReference,
  pointerSha256: Sha256,
})

export const AcceptedPredecessorPointer = AcceptedPredecessorPointerBase.pipe(
  Schema.filter((pointer) => {
    const { pointerSha256: _, ...identity } = pointer
    return pointer.pointerSha256 === canonicalSha256(identity)
      ? true
      : "pointerSha256 does not match accepted predecessor identity"
  }),
)
export type AcceptedPredecessorPointer = typeof AcceptedPredecessorPointer.Type

export const ExactArtifactSource = Schema.Struct({
  role: StageSourceRole,
  artifact: ArtifactReference,
  acceptedPointer: AcceptedPredecessorPointer,
  content: boundedUtf8(MAX_STAGE_SOURCE_BYTES, "Stage source"),
}).pipe(
  Schema.filter((source) =>
    source.role === source.acceptedPointer.role &&
    canonicalSha256(source.artifact) === canonicalSha256(source.acceptedPointer.artifact)
      ? true
      : "Source artifact does not match its accepted predecessor pointer",
  ),
  Schema.filter((source) =>
    createHash("sha256").update(source.content, "utf8").digest("hex") ===
    source.artifact.contentSha256
      ? true
      : "Source content does not match contentSha256",
  ),
)
export type ExactArtifactSource = typeof ExactArtifactSource.Type

export class StageSourceCurrentnessMismatch extends Data.TaggedError(
  "StageSourceCurrentnessMismatch",
)<{
  readonly reason:
    | "generation"
    | "snapshot"
    | "run_ordinal"
    | "stage_revision"
    | "target_parent"
    | "contract"
    | "pointer_identity"
  readonly role?: StageSourceRole
  readonly index?: number
  readonly expected: unknown
  readonly actual: unknown
}> {}

export function compareAcceptedPredecessorCurrentness(
  expected: AcceptedPredecessorPointer,
  actual: AcceptedPredecessorPointer,
  index: number,
): StageSourceCurrentnessMismatch | undefined {
  const mismatch = (
    reason: StageSourceCurrentnessMismatch["reason"],
    wanted: unknown,
    got: unknown,
  ) =>
    new StageSourceCurrentnessMismatch({
      reason,
      role: expected.role,
      index,
      expected: wanted,
      actual: got,
    })
  if (expected.artifact.generation !== actual.artifact.generation)
    return mismatch("generation", expected.artifact.generation, actual.artifact.generation)
  if (expected.snapshotSha256 !== actual.snapshotSha256)
    return mismatch("snapshot", expected.snapshotSha256, actual.snapshotSha256)
  if (expected.runOrdinal !== actual.runOrdinal)
    return mismatch("run_ordinal", expected.runOrdinal, actual.runOrdinal)
  if (
    expected.acceptedStageRevision !== actual.acceptedStageRevision ||
    actual.acceptedStageRevision !== actual.artifact.stageRevision
  )
    return mismatch("stage_revision", expected.acceptedStageRevision, actual.artifact.stageRevision)
  if (expected.targetParentSha !== actual.targetParentSha)
    return mismatch("target_parent", expected.targetParentSha, actual.targetParentSha)
  if (
    canonicalSha256({
      contract: expected.contract,
      registration: expected.contractRegistrationSha256,
    }) !==
    canonicalSha256({ contract: actual.contract, registration: actual.contractRegistrationSha256 })
  )
    return mismatch(
      "contract",
      { contract: expected.contract, registration: expected.contractRegistrationSha256 },
      { contract: actual.contract, registration: actual.contractRegistrationSha256 },
    )
  if (expected.pointerSha256 !== actual.pointerSha256)
    return mismatch("pointer_identity", expected, actual)
  return undefined
}

const TechnicalSources = Schema.Array(ExactArtifactSource).pipe(Schema.maxItems(5))

const ExactStageSourcesBase = Schema.Struct({
  ...ExactStageScope.fields,
  ticketRevision: TicketRevisionReference,
  sources: TechnicalSources,
  sourceSetSha256: Sha256,
  target: RepositoryTarget,
  revisionIntent: Schema.optional(RevisionIntent),
})

export const ExactStageSources = ExactStageSourcesBase.pipe(
  Schema.filter((value) =>
    value.sourceSetSha256 ===
    canonicalSha256(value.sources.map(({ role, artifact }) => ({ role, artifact })))
      ? true
      : "sourceSetSha256 does not match ordered source identities",
  ),
  Schema.filter((value) => {
    const repository = value.target.repository
    const valid =
      value.ticketRevision.workflowId === value.workflowId &&
      value.sources.every(({ role, artifact, acceptedPointer }) => {
        const expectedStageKey = stageKeyBySourceRole[role]
        return (
          artifact.workflowId === value.workflowId &&
          artifact.generation === value.generation &&
          artifact.stageKey === expectedStageKey &&
          artifact.repository.providerInstanceId === repository.providerInstanceId &&
          artifact.repository.repositoryId === repository.repositoryId &&
          acceptedPointer.acceptedStageRevision === artifact.stageRevision
        )
      })
    return valid ? true : "Source authority does not match the request scope and target"
  }),
  Schema.filter((value) =>
    encodedBytes(value) <= MAX_EXACT_STAGE_SOURCES_BYTES
      ? true
      : `Exact stage sources exceed ${MAX_EXACT_STAGE_SOURCES_BYTES} encoded bytes`,
  ),
)
export type ExactStageSources = typeof ExactStageSources.Type

export const StageTaskAuthority = Schema.Struct({
  ticketRevision: TicketRevisionReference,
  sources: TechnicalSources,
  revisionIntent: Schema.optional(RevisionIntent),
  structureAuthority: Schema.optional(StructureAuthority),
})
export type StageTaskAuthority = typeof StageTaskAuthority.Type

export const StageExecutionContext = Schema.Struct({
  scope: ExactStageScope,
  target: RepositoryTarget,
})
export type StageExecutionContext = typeof StageExecutionContext.Type

export const PreparedStageOutput = Schema.Union(
  Schema.TaggedStruct("Document", {
    text: BoundedMarkdown(MAX_DOCUMENT_RESULT_BYTES),
  }),
  Schema.TaggedStruct("ImplementationStep", {
    value: JsonValueSchema,
  }),
)
export type PreparedStageOutput = typeof PreparedStageOutput.Type

const StageProduceInputBase = Schema.Struct({
  contractVersion: Schema.Literal(1),
  scope: ExactStageScope,
  contract: StageContractRef,
  request: JsonValueSchema,
  requestSha256: Sha256,
})

function requestSources(request: unknown): unknown {
  if (request === null || typeof request !== "object" || !("sources" in request)) {
    throw new Error("request must contain exact sources")
  }
  return request.sources
}

export const StageProduceInput = StageProduceInputBase.pipe(
  Schema.filter((value) =>
    value.requestSha256 === canonicalSha256(value.request)
      ? true
      : "requestSha256 does not match request",
  ),
  Schema.filter((value) => {
    try {
      Schema.decodeUnknownSync(ExactStageSources)(requestSources(value.request))
      return true
    } catch {
      return "sourceSetSha256 does not match ordered source identities"
    }
  }),
  Schema.filter((value) => {
    try {
      const nestedScope = Schema.decodeUnknownSync(ExactStageScope)(requestSources(value.request))
      return canonicalSha256(value.scope) === canonicalSha256(nestedScope)
        ? true
        : "scope does not match request sources"
    } catch {
      return "scope does not match request sources"
    }
  }),
)
export type StageProduceInput = typeof StageProduceInput.Type

export const encodeStageProduceInput = (
  scope: ExactStageScope,
  contract: typeof StageContractRef.Type,
  decodedRequest: JsonValue,
): StageProduceInput => {
  const encodedScope = Schema.decodeUnknownSync(ExactStageScope)(scope)
  const nestedScope = Schema.decodeUnknownSync(ExactStageScope)(requestSources(decodedRequest))
  if (canonicalSha256(encodedScope) !== canonicalSha256(nestedScope)) {
    throw new Error("scope does not match request sources")
  }
  return {
    contractVersion: 1,
    scope: encodedScope,
    contract,
    request: decodedRequest,
    requestSha256: canonicalSha256(decodedRequest),
  }
}

export const BoundedTaskTitle = boundedUtf8(MAX_TASK_TITLE_BYTES, "Task title")
export const BoundedTaskPrompt = boundedUtf8(MAX_TASK_PROMPT_BYTES, "Task prompt")

const stageKeyBySourceRole: Readonly<Record<StageSourceRole, string>> = {
  Questions: "questions",
  Research: "research",
  Design: "design",
  Structure: "structure",
  Plan: "plan",
  Implementation: "implementation",
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

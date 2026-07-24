import { Schema } from "effect"
import { MAX_AGENT_OUTPUT_BYTES, MAX_STAGE_REQUEST_BYTES } from "../../agent-harness"
import type { JsonValue } from "../../json"
import type { StageContract } from "../stage-catalog"
import {
  ExactStageSources,
  RepositoryRelativePath,
  boundedUtf8,
  isOrderedRoleSubsequence,
} from "./common"
import { GitSha, PositiveVersion } from "../domain"

export const MAX_CHANGED_PATHS = 128
export const MAX_CHANGED_PATH_BYTES = 512
export const MAX_SCENARIO_EVIDENCE_ITEMS = 256
export const MAX_SCENARIO_EVIDENCE_BYTES = 4_000

const ImplementationSources = ExactStageSources.pipe(
  Schema.filter((sources) =>
    isOrderedRoleSubsequence(
      sources.sources.map(({ role }) => role),
      ["Plan", "Structure", "Design", "Research", "Questions"],
    )
      ? true
      : "Implementation accepts only the Plan/Structure/Design/Research/Questions predecessor subsequence",
  ),
)

const ChangedPath = RepositoryRelativePath.pipe(
  Schema.filter((path) =>
    Buffer.byteLength(path, "utf8") <= MAX_CHANGED_PATH_BYTES
      ? true
      : `Changed path exceeds ${MAX_CHANGED_PATH_BYTES} UTF-8 bytes`,
  ),
)

export const BoundedChangedPaths = Schema.Array(ChangedPath).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_CHANGED_PATHS),
)

export const BoundedScenarioEvidence = Schema.Array(
  boundedUtf8(MAX_SCENARIO_EVIDENCE_BYTES, "Scenario evidence").pipe(Schema.minLength(1)),
).pipe(Schema.minItems(1), Schema.maxItems(MAX_SCENARIO_EVIDENCE_ITEMS))

export const ImplementationRequest = Schema.Struct({
  _tag: Schema.Literal("ImplementationRequest"),
  sources: ImplementationSources,
  checkpointPosition: PositiveVersion,
  expectedParentSha: GitSha,
}).pipe(
  Schema.filter((request) =>
    request.expectedParentSha === request.sources.target.expectedParentSha
      ? true
      : "Implementation expected parent does not match the repository target",
  ),
)

export const ImplementationResult = Schema.Union(
  Schema.TaggedStruct("PreparedCommit", {
    candidateCommitSha: GitSha,
    expectedParentSha: GitSha,
    changedPaths: BoundedChangedPaths,
    final: Schema.Literal(false),
    scenarioEvidence: Schema.optional(Schema.Undefined),
  }),
  Schema.TaggedStruct("PreparedFinalCommit", {
    candidateCommitSha: GitSha,
    expectedParentSha: GitSha,
    changedPaths: BoundedChangedPaths,
    final: Schema.Literal(true),
    scenarioEvidence: BoundedScenarioEvidence,
  }),
)

export const implementationStageContract = {
  ref: { name: "qrspi.implementation", contractVersion: 1 },
  stageKey: "implementation",
  implementationRevision: "qrspi.implementation.v1",
  kind: "implementation",
  requestSchema: ImplementationRequest,
  resultSchema: ImplementationResult,
  maxRequestBytes: MAX_STAGE_REQUEST_BYTES,
  maxResultBytes: MAX_AGENT_OUTPUT_BYTES,
  compatibility: (definition) => {
    if (definition.key !== "implementation")
      throw new Error("Implementation requires the implementation stage key")
    if (
      definition.designPolicy !== undefined ||
      definition.promotionPolicy !== undefined ||
      definition.structurePolicy !== undefined
    )
      throw new Error("Implementation forbids specialized policy fields")
    if (
      definition.outputPolicy._tag !== "ImplementationCheckpoint" ||
      definition.outputPolicy.contractId !== "qrspi.implementation-checkpoint" ||
      definition.outputPolicy.contractVersion !== 1
    )
      throw new Error("Implementation requires its checkpoint output contract")
  },
  assembleRequest: (sources, local) => ({
    _tag: "ImplementationRequest",
    sources,
    checkpointPosition: checkpointPosition(local),
    expectedParentSha: sources.target.expectedParentSha,
  }),
  buildTask: (request) => ({
    title: `Implement workflow checkpoint ${request.checkpointPosition}`,
    prompt:
      "Implement the accepted Plan using the separately materialized ticket and technical authority. Return only the prepared commit contract.",
    authority: {
      ticketRevision: request.sources.ticketRevision,
      sources: request.sources.sources,
      ...(request.sources.revisionIntent === undefined
        ? {}
        : { revisionIntent: request.sources.revisionIntent }),
    },
    resultSchema: ImplementationResult,
  }),
  prepareOutput: (result, context) => {
    if (result.expectedParentSha !== context.target.expectedParentSha) {
      throw new Error("Prepared commit expected parent does not match execution context")
    }
    return { _tag: "ImplementationStep", value: result }
  },
} satisfies StageContract<
  typeof ImplementationRequest.Type,
  typeof ImplementationRequest.Encoded,
  typeof ImplementationResult.Type,
  typeof ImplementationResult.Encoded
>

function checkpointPosition(local: JsonValue | undefined): number {
  if (local === null || typeof local !== "object" || !("checkpointPosition" in local)) {
    throw new Error("Implementation requires a checkpoint position")
  }
  return Schema.decodeUnknownSync(PositiveVersion)(local.checkpointPosition)
}

import { Schema } from "effect"
import { MAX_AGENT_OUTPUT_BYTES, MAX_STAGE_REQUEST_BYTES } from "../../agent-harness"
import type { JsonValue } from "../../json"
import type { StageContract } from "../stage-catalog"
import {
  BoundedMarkdown,
  ExactStageSources,
  MAX_DOCUMENT_RESULT_BYTES,
  StructureAuthority,
  exactPolicyReference,
  isOrderedRoleSubsequence,
} from "./common"
import { structurePolicyReference } from "./design"

const StructureSources = ExactStageSources.pipe(
  Schema.filter((sources) =>
    sources.sources.filter(({ role }) => role === "Design").length === 1 &&
    isOrderedRoleSubsequence(
      sources.sources.map(({ role }) => role),
      ["Design", "Research", "Questions"],
    )
      ? true
      : "Structure requires exactly one Design predecessor followed by Research/Questions",
  ),
)

export const StructureRequest = Schema.Struct({
  _tag: Schema.Literal("StructureRequest"),
  sources: StructureSources,
  structurePolicy: exactPolicyReference(structurePolicyReference),
  authority: StructureAuthority,
}).pipe(
  Schema.filter((request) => {
    const { authority, sources } = request
    const sameRepository =
      authority.graph.repository.providerInstanceId ===
        sources.target.repository.providerInstanceId &&
      authority.graph.repository.repositoryId === sources.target.repository.repositoryId
    const designSource = sources.sources.find(({ role }) => role === "Design")
    return designSource !== undefined &&
      authority.acceptancePackage.workflowId === sources.workflowId &&
      authority.acceptancePackage.generation === sources.generation &&
      authority.acceptancePackage.designStageRevision ===
        designSource.acceptedPointer.acceptedStageRevision &&
      authority.acceptancePackage.designStageRevision === designSource.artifact.stageRevision &&
      sameRepository
      ? true
      : "Structure authority is outside the exact stage scope"
  }),
)

export const StructureResult = Schema.Struct({
  _tag: Schema.Literal("Structure"),
  document: BoundedMarkdown(MAX_DOCUMENT_RESULT_BYTES),
})

export const structureStageContract = {
  ref: { name: "qrspi.structure", contractVersion: 1 },
  stageKey: "structure",
  implementationRevision: "qrspi.structure.v1",
  kind: "document",
  requestSchema: StructureRequest,
  resultSchema: StructureResult,
  maxRequestBytes: MAX_STAGE_REQUEST_BYTES,
  maxResultBytes: MAX_AGENT_OUTPUT_BYTES,
  compatibility: (definition) => {
    if (definition.key !== "structure")
      throw new Error("Structure requires the structure stage key")
    if (
      definition.structurePolicy?.name !== structurePolicyReference.name ||
      definition.structurePolicy.version !== structurePolicyReference.version
    )
      throw new Error("Structure requires the Structure policy")
    if (definition.designPolicy !== undefined || definition.promotionPolicy !== undefined)
      throw new Error("Structure forbids Design policy fields")
    if (
      definition.outputPolicy._tag !== "Artifact" ||
      definition.outputPolicy.mediaType !== "text/markdown"
    )
      throw new Error("Structure requires Markdown artifact output")
  },
  assembleRequest: (sources, local) => ({
    _tag: "StructureRequest",
    sources,
    structurePolicy: structurePolicyReference,
    authority: localStructureAuthority(local),
  }),
  buildTask: (request) => ({
    title: "Structure workflow solution",
    prompt:
      "Structure the workflow solution using the separately materialized ticket, accepted technical authority, and owner-issued Design authority. Return only the Structure document contract.",
    authority: {
      ticketRevision: request.sources.ticketRevision,
      sources: request.sources.sources,
      ...(request.sources.revisionIntent === undefined
        ? {}
        : { revisionIntent: request.sources.revisionIntent }),
      structureAuthority: request.authority,
    },
    resultSchema: StructureResult,
  }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.document }),
} satisfies StageContract<
  typeof StructureRequest.Type,
  typeof StructureRequest.Encoded,
  typeof StructureResult.Type,
  typeof StructureResult.Encoded
>

function localStructureAuthority(local: JsonValue | undefined) {
  if (local === null || typeof local !== "object" || !("structureAuthority" in local)) {
    throw new Error("Structure requires owner-issued Design authority")
  }
  return Schema.decodeUnknownSync(StructureAuthority)(local.structureAuthority)
}

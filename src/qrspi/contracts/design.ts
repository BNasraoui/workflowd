import { Schema } from "effect"
import { MAX_AGENT_OUTPUT_BYTES, MAX_STAGE_REQUEST_BYTES } from "../../agent-harness"
import { PolicyReference } from "../domain"
import type { StageContract } from "../stage-catalog"
import {
  BoundedMarkdown,
  ExactStageSources,
  MAX_DOCUMENT_RESULT_BYTES,
  exactPolicyReference,
  isOrderedRoleSubsequence,
} from "./common"

export const designPolicyReference = { name: "qrspi.design-policy", version: 1 } as const
export const promotionPolicyReference = { name: "qrspi.promotion-policy", version: 1 } as const
export const structurePolicyReference = { name: "qrspi.structure-policy", version: 1 } as const

const DesignSources = ExactStageSources.pipe(
  Schema.filter((sources) =>
    isOrderedRoleSubsequence(
      sources.sources.map(({ role }) => role),
      ["Research", "Questions"],
    )
      ? true
      : "Design accepts only the Research/Questions predecessor subsequence",
  ),
)

export const DesignRequest = Schema.Struct({
  _tag: Schema.Literal("DesignRequest"),
  sources: DesignSources,
  designPolicy: exactPolicyReference(designPolicyReference),
  promotionPolicy: exactPolicyReference(promotionPolicyReference),
  structurePolicy: exactPolicyReference(structurePolicyReference),
})

export const DesignResult = Schema.Struct({
  _tag: Schema.Literal("Design"),
  document: BoundedMarkdown(MAX_DOCUMENT_RESULT_BYTES),
})

export const designStageContract = {
  ref: { name: "qrspi.design", contractVersion: 1 },
  stageKey: "design",
  implementationRevision: "qrspi.design.v1",
  kind: "document",
  requestSchema: DesignRequest,
  resultSchema: DesignResult,
  maxRequestBytes: MAX_STAGE_REQUEST_BYTES,
  maxResultBytes: MAX_AGENT_OUTPUT_BYTES,
  compatibility: (definition) => {
    if (definition.key !== "design") throw new Error("Design requires the design stage key")
    if (!samePolicy(definition.designPolicy, designPolicyReference))
      throw new Error("Design requires the Design policy")
    if (!samePolicy(definition.promotionPolicy, promotionPolicyReference))
      throw new Error("Design requires the promotion policy")
    if (definition.structurePolicy !== undefined)
      throw new Error("Design forbids a configured Structure policy")
    if (
      definition.outputPolicy._tag !== "Artifact" ||
      definition.outputPolicy.mediaType !== "text/markdown"
    )
      throw new Error("Design requires Markdown artifact output")
  },
  assembleRequest: (sources) => ({
    _tag: "DesignRequest",
    sources,
    designPolicy: designPolicyReference,
    promotionPolicy: promotionPolicyReference,
    structurePolicy: structurePolicyReference,
  }),
  buildTask: (request) => ({
    title: "Design workflow solution",
    prompt:
      "Design the workflow solution using the separately materialized ticket and accepted technical authority. Return only the Design document contract.",
    authority: {
      ticketRevision: request.sources.ticketRevision,
      sources: request.sources.sources,
    },
    resultSchema: DesignResult,
  }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.document }),
} satisfies StageContract<
  typeof DesignRequest.Type,
  typeof DesignRequest.Encoded,
  typeof DesignResult.Type,
  typeof DesignResult.Encoded
>

function samePolicy(
  actual: typeof PolicyReference.Type | undefined,
  expected: typeof PolicyReference.Type,
): boolean {
  return actual?.name === expected.name && actual.version === expected.version
}

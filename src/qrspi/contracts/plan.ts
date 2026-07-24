import { Schema } from "effect"
import { MAX_AGENT_OUTPUT_BYTES, MAX_STAGE_REQUEST_BYTES } from "../../agent-harness"
import type { StageContract } from "../stage-catalog"
import {
  BoundedMarkdown,
  ExactStageSources,
  MAX_DOCUMENT_RESULT_BYTES,
  isOrderedRoleSubsequence,
} from "./common"

const PlanSources = ExactStageSources.pipe(
  Schema.filter((sources) =>
    isOrderedRoleSubsequence(
      sources.sources.map(({ role }) => role),
      ["Structure", "Design", "Research", "Questions"],
    )
      ? true
      : "Plan accepts only the Structure/Design/Research/Questions predecessor subsequence",
  ),
)

export const PlanRequest = Schema.Struct({
  _tag: Schema.Literal("PlanRequest"),
  sources: PlanSources,
})

export const PlanResult = Schema.Struct({
  _tag: Schema.Literal("Plan"),
  document: BoundedMarkdown(MAX_DOCUMENT_RESULT_BYTES),
})

export const planStageContract = {
  ref: { name: "qrspi.plan", contractVersion: 1 },
  stageKey: "plan",
  implementationRevision: "qrspi.plan.v1",
  kind: "document",
  requestSchema: PlanRequest,
  resultSchema: PlanResult,
  maxRequestBytes: MAX_STAGE_REQUEST_BYTES,
  maxResultBytes: MAX_AGENT_OUTPUT_BYTES,
  compatibility: (definition) => {
    if (definition.key !== "plan") throw new Error("Plan requires the plan stage key")
    if (
      definition.designPolicy !== undefined ||
      definition.promotionPolicy !== undefined ||
      definition.structurePolicy !== undefined
    )
      throw new Error("Plan forbids specialized policy fields")
    if (
      definition.outputPolicy._tag !== "Artifact" ||
      definition.outputPolicy.mediaType !== "text/markdown"
    )
      throw new Error("Plan requires Markdown artifact output")
  },
  assembleRequest: (sources) => ({ _tag: "PlanRequest", sources }),
  buildTask: (request) => ({
    title: "Plan workflow implementation",
    prompt:
      "Plan the workflow implementation using the separately materialized ticket and accepted technical authority. Return only the Plan document contract.",
    authority: {
      ticketRevision: request.sources.ticketRevision,
      sources: request.sources.sources,
      ...(request.sources.revisionIntent === undefined
        ? {}
        : { revisionIntent: request.sources.revisionIntent }),
    },
    resultSchema: PlanResult,
  }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.document }),
} satisfies StageContract<
  typeof PlanRequest.Type,
  typeof PlanRequest.Encoded,
  typeof PlanResult.Type,
  typeof PlanResult.Encoded
>

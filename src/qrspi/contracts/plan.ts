import { Schema } from "effect"
import type { StageContract } from "../stage-catalog"
import {
  BoundedMarkdown,
  ExactStageSources,
  MAX_DOCUMENT_RESULT_BYTES,
  documentStageContractDefaults,
  isOrderedRoleSubsequence,
  taskAuthorityFromSources,
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
  ...documentStageContractDefaults("plan", "Plan"),
  requestSchema: PlanRequest,
  resultSchema: PlanResult,
  assembleRequest: (sources) => ({ _tag: "PlanRequest", sources }),
  buildTask: (request) => ({
    title: "Plan workflow implementation",
    prompt:
      "Plan the workflow implementation using the separately materialized ticket and accepted technical authority. Return only the Plan document contract.",
    authority: taskAuthorityFromSources(request.sources),
    resultSchema: PlanResult,
  }),
} satisfies StageContract<
  typeof PlanRequest.Type,
  typeof PlanRequest.Encoded,
  typeof PlanResult.Type,
  typeof PlanResult.Encoded
>

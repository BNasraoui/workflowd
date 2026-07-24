import { Schema } from "effect"
import type { StageContract } from "../stage-catalog"
import {
  BoundedMarkdown,
  ExactStageSources,
  MAX_DOCUMENT_RESULT_BYTES,
  documentStageContractDefaults,
  taskAuthorityFromSources,
} from "./common"

const ResearchSources = ExactStageSources.pipe(
  Schema.filter((sources) => {
    if (sources.sources.length === 0) return true
    return sources.sources.length === 1 && sources.sources[0]?.role === "Questions"
      ? true
      : "Research accepts only the Questions predecessor subsequence"
  }),
)

export const ResearchRequest = Schema.Struct({
  _tag: Schema.Literal("ResearchRequest"),
  sources: ResearchSources,
})

export const ResearchResult = Schema.Struct({
  _tag: Schema.Literal("Research"),
  document: BoundedMarkdown(MAX_DOCUMENT_RESULT_BYTES),
})

export const researchStageContract = {
  ...documentStageContractDefaults("research", "Research"),
  requestSchema: ResearchRequest,
  resultSchema: ResearchResult,
  assembleRequest: (sources) => ({ _tag: "ResearchRequest", sources }),
  buildTask: (request) => ({
    title: "Research workflow solution",
    prompt:
      "Research the workflow solution using the separately materialized ticket and accepted Questions authority. Return only the Research document contract.",
    authority: taskAuthorityFromSources(request.sources),
    resultSchema: ResearchResult,
  }),
} satisfies StageContract<
  typeof ResearchRequest.Type,
  typeof ResearchRequest.Encoded,
  typeof ResearchResult.Type,
  typeof ResearchResult.Encoded
>

import { Schema } from "effect"
import type { StageContract } from "../stage-catalog"
import {
  BoundedMarkdown,
  ExactStageSources,
  MAX_DOCUMENT_RESULT_BYTES,
  documentStageContractDefaults,
  taskAuthorityFromSources,
} from "./common"

export const QuestionsRequest = Schema.Struct({
  _tag: Schema.Literal("QuestionsRequest"),
  sources: ExactStageSources.pipe(
    Schema.filter((sources) =>
      sources.sources.length === 0 ? true : "Questions accepts no predecessor sources",
    ),
  ),
})

export const QuestionsResult = Schema.Struct({
  _tag: Schema.Literal("Questions"),
  document: BoundedMarkdown(MAX_DOCUMENT_RESULT_BYTES),
})

export const questionsStageContract = {
  ...documentStageContractDefaults("questions", "Questions"),
  requestSchema: QuestionsRequest,
  resultSchema: QuestionsResult,
  assembleRequest: (sources) => ({ _tag: "QuestionsRequest", sources }),
  buildTask: (request) => ({
    title: "Answer workflow questions",
    prompt:
      "Answer the product questions using the separately materialized ticket authority. Return only the Questions document contract.",
    authority: taskAuthorityFromSources(request.sources),
    resultSchema: QuestionsResult,
  }),
} satisfies StageContract<
  typeof QuestionsRequest.Type,
  typeof QuestionsRequest.Encoded,
  typeof QuestionsResult.Type,
  typeof QuestionsResult.Encoded
>

import { Schema } from "effect"
import { MAX_AGENT_OUTPUT_BYTES, MAX_STAGE_REQUEST_BYTES } from "../../agent-harness"
import type { StageContract } from "../stage-catalog"
import { BoundedMarkdown, ExactStageSources, MAX_DOCUMENT_RESULT_BYTES } from "./common"

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
  ref: { name: "qrspi.questions", contractVersion: 1 },
  stageKey: "questions",
  implementationRevision: "qrspi.questions.v1",
  kind: "document",
  requestSchema: QuestionsRequest,
  resultSchema: QuestionsResult,
  maxRequestBytes: MAX_STAGE_REQUEST_BYTES,
  maxResultBytes: MAX_AGENT_OUTPUT_BYTES,
  compatibility: (definition) => {
    if (definition.key !== "questions")
      throw new Error("Questions requires the questions stage key")
    if (
      definition.designPolicy !== undefined ||
      definition.promotionPolicy !== undefined ||
      definition.structurePolicy !== undefined
    )
      throw new Error("Questions forbids specialized policy fields")
    if (
      definition.outputPolicy._tag !== "Artifact" ||
      definition.outputPolicy.mediaType !== "text/markdown"
    )
      throw new Error("Questions requires Markdown artifact output")
  },
  assembleRequest: (sources) => ({ _tag: "QuestionsRequest", sources }),
  buildTask: (request) => ({
    title: "Answer workflow questions",
    prompt:
      "Answer the product questions using the separately materialized ticket authority. Return only the Questions document contract.",
    authority: {
      ticketRevision: request.sources.ticketRevision,
      sources: request.sources.sources,
      ...(request.sources.revisionIntent === undefined
        ? {}
        : { revisionIntent: request.sources.revisionIntent }),
    },
    resultSchema: QuestionsResult,
  }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.document }),
} satisfies StageContract<
  typeof QuestionsRequest.Type,
  typeof QuestionsRequest.Encoded,
  typeof QuestionsResult.Type,
  typeof QuestionsResult.Encoded
>

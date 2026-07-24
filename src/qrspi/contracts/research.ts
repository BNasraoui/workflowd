import { Schema } from "effect"
import { MAX_AGENT_OUTPUT_BYTES, MAX_STAGE_REQUEST_BYTES } from "../../agent-harness"
import type { StageContract } from "../stage-catalog"
import { BoundedMarkdown, ExactStageSources, MAX_DOCUMENT_RESULT_BYTES } from "./common"

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
  ref: { name: "qrspi.research", contractVersion: 1 },
  stageKey: "research",
  implementationRevision: "qrspi.research.v1",
  kind: "document",
  requestSchema: ResearchRequest,
  resultSchema: ResearchResult,
  maxRequestBytes: MAX_STAGE_REQUEST_BYTES,
  maxResultBytes: MAX_AGENT_OUTPUT_BYTES,
  compatibility: (definition) => {
    if (definition.key !== "research") throw new Error("Research requires the research stage key")
    if (
      definition.designPolicy !== undefined ||
      definition.promotionPolicy !== undefined ||
      definition.structurePolicy !== undefined
    )
      throw new Error("Research forbids specialized policy fields")
    if (
      definition.outputPolicy._tag !== "Artifact" ||
      definition.outputPolicy.mediaType !== "text/markdown"
    )
      throw new Error("Research requires Markdown artifact output")
  },
  assembleRequest: (sources) => ({ _tag: "ResearchRequest", sources }),
  buildTask: (request) => ({
    title: "Research workflow solution",
    prompt:
      "Research the workflow solution using the separately materialized ticket and accepted Questions authority. Return only the Research document contract.",
    authority: {
      ticketRevision: request.sources.ticketRevision,
      sources: request.sources.sources,
    },
    resultSchema: ResearchResult,
  }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.document }),
} satisfies StageContract<
  typeof ResearchRequest.Type,
  typeof ResearchRequest.Encoded,
  typeof ResearchResult.Type,
  typeof ResearchResult.Encoded
>

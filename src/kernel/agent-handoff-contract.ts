import { Schema } from "effect"
import { JsonValueSchema } from "../json"
import type { EventCondition } from "./event-store"

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const boundedText = (maximum: number) =>
  Schema.NonEmptyString.pipe(
    Schema.filter((value) => utf8Bytes(value) <= maximum, {
      message: () => `must be at most ${maximum} UTF-8 bytes`,
    }),
  )

const StableSessionId = boundedText(256)
const ContractName = boundedText(256)
const PromptText = boundedText(65_536)
const PositiveInteger = Schema.Int.pipe(Schema.positive())
const Instant = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/))

export const AGENT_SESSION_COMPLETED_TYPE = "agent.session.completed"
export const AGENT_SESSION_COMPLETED_VERSION = 1
export const WAIT_FOR_AGENT_WORKFLOW_TYPE = "wait_for_agent"
export const WAIT_FOR_AGENT_WORKFLOW_VERSION = 1

export const AgentSessionCompletedEventV1 = Schema.Struct({
  childSessionId: StableSessionId,
  childSessionGeneration: PositiveInteger,
  completionId: boundedText(256),
  completedAt: Instant,
})
export type AgentSessionCompletedEventV1 = typeof AgentSessionCompletedEventV1.Type

export const WaitForAgentWorkflowV1 = Schema.Struct({
  kind: Schema.Literal(WAIT_FOR_AGENT_WORKFLOW_TYPE),
  childSessionId: StableSessionId,
  childSessionGeneration: PositiveInteger,
  parentSessionId: StableSessionId,
  resumePrompt: JsonValueSchema,
  resumePromptText: PromptText,
  outputContract: ContractName,
  outputContractVersion: PositiveInteger,
  retryPolicy: Schema.Struct({ maxAttempts: PositiveInteger }),
})
export type WaitForAgentWorkflowV1 = typeof WaitForAgentWorkflowV1.Type

export const ResumeParentAgentJobV1 = Schema.Struct({
  kind: Schema.Literal("resume_parent_agent"),
  parentSessionId: StableSessionId,
  resumePrompt: JsonValueSchema,
  resumePromptText: PromptText,
  outputContract: ContractName,
  outputContractVersion: PositiveInteger,
  registeredAt: Instant,
})
export type ResumeParentAgentJobV1 = typeof ResumeParentAgentJobV1.Type

export const agentSessionCompletionCondition = (
  wait: Pick<WaitForAgentWorkflowV1, "childSessionId" | "childSessionGeneration">,
): EventCondition => ({
  type: AGENT_SESSION_COMPLETED_TYPE,
  version: AGENT_SESSION_COMPLETED_VERSION,
  key: wait.childSessionId,
  correlation: `${wait.childSessionId}:${wait.childSessionGeneration}`,
})

import { Schema } from "effect"

export const MAX_RESUME_PROMPT_BYTES = 32_768
export const MAX_AGENT_WAIT_SESSION_ID_BYTES = 256
export const MAX_AGENT_WAIT_IDEMPOTENCY_KEY_BYTES = 128

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
export const utf8BoundedText = (maximum: number) =>
  Schema.NonEmptyString.pipe(
    Schema.check(
      Schema.makeFilter((value) =>
        utf8Bytes(value) <= maximum ? true : `must be at most ${maximum} UTF-8 bytes`,
      ),
    ),
  )

export const AgentWaitSubmission = Schema.Struct({
  parentSessionId: utf8BoundedText(MAX_AGENT_WAIT_SESSION_ID_BYTES),
  childSessionId: utf8BoundedText(MAX_AGENT_WAIT_SESSION_ID_BYTES),
  resumePrompt: utf8BoundedText(MAX_RESUME_PROMPT_BYTES),
  idempotencyKey: Schema.optional(utf8BoundedText(MAX_AGENT_WAIT_IDEMPOTENCY_KEY_BYTES)),
})
export type AgentWaitSubmission = typeof AgentWaitSubmission.Type

export const AgentWaitReceipt = Schema.Struct({
  waitId: Schema.String,
  instanceId: Schema.String,
  status: Schema.Literals(["registered", "duplicate"]),
})
export type AgentWaitReceipt = typeof AgentWaitReceipt.Type

export const AgentWaitRefusal = Schema.Struct({
  error: Schema.String,
  reason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
})
export type AgentWaitRefusal = typeof AgentWaitRefusal.Type

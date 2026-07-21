import { Schema } from "effect"

export const MAX_AGENT_LAUNCH_INTENT_BYTES = 64 * 1024
export const MAX_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024

export const boundedAgentPayload = (maximumBytes: number, name: string) =>
  Schema.Unknown.pipe(
    Schema.filter((value) => {
      try {
        return Buffer.byteLength(JSON.stringify(value), "utf8") <= maximumBytes
          ? true
          : `${name} exceeds ${maximumBytes} encoded UTF-8 bytes`
      } catch {
        return `${name} must be JSON encodable`
      }
    }),
  )

export const AgentLaunchIntentEnvelope = boundedAgentPayload(
  MAX_AGENT_LAUNCH_INTENT_BYTES,
  "Agent launch intent",
)
export const AgentOutputEnvelope = boundedAgentPayload(MAX_AGENT_OUTPUT_BYTES, "Agent output")

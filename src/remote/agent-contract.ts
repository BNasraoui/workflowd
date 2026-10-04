import { createHash } from "node:crypto"
import { Schema } from "effect"
import { AgentRunSubmission } from "../agent-run-contract"
import { ResolvedSelection } from "../execution-selection"

// Base64 fragments keep even a 32 KiB UTF-8 prompt (and JSON escaping) inside
// the deployed 16 KiB envelopes. Neither credentials nor coordinator paths travel.
export const AgentFragment = Schema.Struct({
  transferId: Schema.String,
  digest: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  index: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 127 }))),
  count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 128 }))),
  data: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(8192)),
    Schema.check(Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/)),
  ),
})
export type AgentFragment = typeof AgentFragment.Type
const AgentRunId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^agent-run-[A-Za-z0-9_-]{1,128}$/)),
)
export const RemoteAgentLaunch = Schema.Struct({
  runId: AgentRunId,
  route: Schema.String,
  submission: AgentRunSubmission,
  selection: ResolvedSelection,
  createdAt: Schema.String,
})
export type RemoteAgentLaunch = typeof RemoteAgentLaunch.Type
export const RemoteAgentState = Schema.Struct({
  runId: AgentRunId,
  state: Schema.Literals(["verified", "completed", "failed", "cancelled", "operator_required"]),
  nativeSessionId: Schema.NullOr(Schema.String),
  directory: Schema.String,
  outputTokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  diagnostic: Schema.NullOr(Schema.String),
  finalMessage: Schema.NullOr(Schema.String),
  refusalReason: Schema.optionalKey(Schema.String),
})
export type RemoteAgentState = typeof RemoteAgentState.Type

export const agentFragments = (
  transferId: string,
  document: unknown,
): ReadonlyArray<AgentFragment> => {
  const bytes = Buffer.from(JSON.stringify(document))
  if (bytes.length > 786432) throw new Error("Remote agent transfer exceeds 768 KiB")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const count = Math.ceil(bytes.length / 6144)
  return Array.from({ length: count }, (_, index) => ({
    transferId,
    digest,
    index,
    count,
    data: bytes.subarray(index * 6144, (index + 1) * 6144).toString("base64"),
  }))
}

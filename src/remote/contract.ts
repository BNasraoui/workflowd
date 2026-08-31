import { Schema } from "effect"

export const MAX_REMOTE_MESSAGE_BYTES = 16_384

/** Sub-budgets keeping a claude_resume payload inside the 16 KiB envelope
 * (which is baked into the deployed streams' max_msg_size and cannot grow
 * without a stream migration). */
export const MAX_CLAUDE_RESUME_PROMPT_BYTES = 8_192
export const MAX_CLAUDE_RESUME_SCHEMA_BYTES = 2_048
export const MAX_CLAUDE_RESUME_OUTPUT_BYTES = 12_288

const Identifier = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)))
export const RemoteHostId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)),
)
const Timestamp = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)))),
)
const utf8Bounded = (maximum: number) =>
  Schema.NonEmptyString.pipe(
    Schema.check(
      Schema.makeFilter((value) =>
        new TextEncoder().encode(value).byteLength <= maximum
          ? true
          : `must be at most ${maximum} UTF-8 bytes`,
      ),
    ),
  )

export const RemoteProbeJobV1 = Schema.Struct({
  kind: Schema.Literal("remote_probe"),
  hostId: RemoteHostId,
})
export type RemoteProbeJobV1 = typeof RemoteProbeJobV1.Type

/**
 * A wake for a Claude Code session on the runner's host: continue the
 * session with the canonical resume prompt, then extract the trusted
 * structured acknowledgment against the carried JSON schema. The session id
 * and directory are constrained to shell-inert character sets; the prompt
 * and schema ride as data and must never enter argv or a shell string.
 */
export const ClaudeResumeJobV1 = Schema.Struct({
  kind: Schema.Literal("claude_resume"),
  hostId: RemoteHostId,
  nativeSessionId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/)),
  ),
  directory: Schema.String.pipe(Schema.check(Schema.isPattern(/^\/[A-Za-z0-9._/-]{1,1023}$/))),
  prompt: utf8Bounded(MAX_CLAUDE_RESUME_PROMPT_BYTES),
  extractionSchemaJson: utf8Bounded(MAX_CLAUDE_RESUME_SCHEMA_BYTES),
  turnTimeoutMs: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 10_000, maximum: 600_000 })),
  ),
})
export type ClaudeResumeJobV1 = typeof ClaudeResumeJobV1.Type

const commandBase = {
  version: Schema.Literal(1),
  commandId: Identifier,
  jobId: Identifier,
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  generation: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  hostId: RemoteHostId,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
} as const

/** Probe commands carry no payload key at all, so their encoded form is
 * byte-identical to the pre-claude contract and lagging peers interop. */
export const RemoteProbeCommand = Schema.Struct({
  ...commandBase,
  kind: Schema.Literal("probe"),
})
export const RemoteClaudeResumeCommand = Schema.Struct({
  ...commandBase,
  kind: Schema.Literal("claude_resume"),
  payload: ClaudeResumeJobV1,
})
export const RemoteCommand = Schema.Union([RemoteProbeCommand, RemoteClaudeResumeCommand])
export type RemoteCommand = typeof RemoteCommand.Type

export const RemoteFence = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("fence"),
  jobId: Identifier,
  generation: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  hostId: RemoteHostId,
  disposition: Schema.Literals(["current", "cancelled"]),
  issuedAt: Timestamp,
})
export type RemoteFence = typeof RemoteFence.Type
export const RemoteHostMessage = Schema.Union([
  RemoteProbeCommand,
  RemoteClaudeResumeCommand,
  RemoteFence,
])
export type RemoteHostMessage = typeof RemoteHostMessage.Type

export const ClaudeResumeFailureReason = Schema.Literals([
  "transcript_missing",
  "directory_not_allowed",
  "cli_failed",
  "cli_timeout",
  "output_unparseable",
  "output_oversized",
  "execution_interrupted",
])
export type ClaudeResumeFailureReason = typeof ClaudeResumeFailureReason.Type

const resultBase = {
  version: Schema.Literal(1),
  resultId: Identifier,
  commandId: Identifier,
  jobId: Identifier,
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  generation: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  hostId: RemoteHostId,
  observedAt: Timestamp,
} as const

export const RemoteProbeResult = Schema.Struct({
  ...resultBase,
  kind: Schema.Literal("probe"),
  status: Schema.Literal("succeeded"),
})
export const RemoteClaudeResumeResult = Schema.Struct({
  ...resultBase,
  kind: Schema.Literal("claude_resume"),
  status: Schema.Literals(["succeeded", "failed"]),
  output: Schema.optional(utf8Bounded(MAX_CLAUDE_RESUME_OUTPUT_BYTES)),
  failureReason: Schema.optional(ClaudeResumeFailureReason),
}).pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.status === "succeeded"
        ? value.output !== undefined && value.failureReason === undefined
          ? true
          : "a succeeded claude_resume result carries output and no failureReason"
        : value.failureReason !== undefined && value.output === undefined
          ? true
          : "a failed claude_resume result carries failureReason and no output",
    ),
  ),
)
export const RemoteResult = Schema.Union([RemoteProbeResult, RemoteClaudeResumeResult])
export type RemoteResult = typeof RemoteResult.Type

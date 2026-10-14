import { createHash } from "node:crypto"
import { Schema } from "effect"

export const CredentialAdmissionReason = Schema.Literals([
  "shared_credential_link_broken",
  "shared_credential_diverged",
  "shared_credential_permissions_invalid",
  "credential_relink_in_progress",
  "opencode_grant_migration_incomplete",
  "credential_host_unreachable_or_timed_out",
])
export type CredentialAdmissionReason = typeof CredentialAdmissionReason.Type
export const CredentialClient = Schema.Literals(["codex", "claude", "opencode"])
export type CredentialClient = typeof CredentialClient.Type
const tags = {
  shared_credential_link_broken: "SharedCredentialLinkBroken",
  shared_credential_diverged: "SharedCredentialDiverged",
  shared_credential_permissions_invalid: "SharedCredentialPermissionsInvalid",
  credential_relink_in_progress: "CredentialRelinkInProgress",
  opencode_grant_migration_incomplete: "OpenCodeGrantMigrationIncomplete",
  credential_host_unreachable_or_timed_out: "CredentialHostUnreachableOrTimedOut",
} as const
export type CredentialCheckError = Error & {
  readonly _tag: (typeof tags)[CredentialAdmissionReason]
  readonly client: CredentialClient
  readonly reason: CredentialAdmissionReason
  readonly detail: string
}
export function credentialRefusal(
  client: CredentialClient,
  reason: CredentialAdmissionReason,
): CredentialCheckError {
  const detail = `${client}: ${reason}`
  return Object.assign(new Error(detail), { _tag: tags[reason], client, reason, detail })
}
export function credentialReason(error: unknown): CredentialAdmissionReason | undefined {
  if (typeof error !== "object" || error === null) return undefined
  if ("reason" in error && Schema.is(CredentialAdmissionReason)(error.reason)) return error.reason
  if ("cause" in error && error.cause !== error) return credentialReason(error.cause)
  return undefined
}
export const CredentialRequest = Schema.Struct({
  operation: Schema.Literal("checkCredentials"),
  client: CredentialClient,
})
export const CredentialResponse = Schema.Union([
  Schema.Struct({ admitted: Schema.Literal(true) }),
  Schema.Struct({ admitted: Schema.Literal(false), reason: CredentialAdmissionReason }),
])

const HostId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/))
const HostText = Schema.String.check(Schema.isMaxLength(262144))
export const HostStart = Schema.Struct({
  operation: Schema.Literal("start"),
  runId: HostId,
  profile: Schema.Literals([
    "codex",
    "claude",
    "codex-preflight",
    "claude-preflight",
    "claude-resume",
    "claude-session",
    "codex-discovery",
    "codex-server",
    "workspace",
  ]),
  directory: Schema.String,
  prompt: HostText,
  model: Schema.NullOr(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  nativeSessionId: Schema.optionalKey(HostId),
  repository: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  launchId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400000 })),
  ),
})
export type HostStart = typeof HostStart.Type
export const HostRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("listOwned"),
    cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ operation: Schema.Literal("connect"), runId: HostId, launchId: Schema.String }),
  HostStart,
  Schema.Struct({ operation: Schema.Literal("inspect"), runId: HostId }),
  Schema.Struct({ operation: Schema.Literal("stop"), runId: HostId, launchId: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("exchange"),
    runId: HostId,
    launchId: Schema.String,
    file: Schema.Literals(["events", "stderr", "result"]),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
])
export type HostRequest = typeof HostRequest.Type
export const OwnedProcess = Schema.Struct({
  runId: HostId,
  launchId: Schema.String,
  unit: Schema.String,
  invocationId: Schema.NullOr(Schema.String),
  uid: Schema.Int,
  pid: Schema.Int,
  started: Schema.String,
  active: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.optionalKey(Schema.Boolean),
})
export type OwnedProcess = typeof OwnedProcess.Type
export const HostResponse = Schema.Union([
  Schema.Struct({
    admitted: Schema.Literal(true),
    processes: Schema.Array(OwnedProcess),
    next: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({ admitted: Schema.Literal(true), process: Schema.NullOr(OwnedProcess) }),
  Schema.Struct({ admitted: Schema.Literal(true), bytes: Schema.String }),
  Schema.Struct({
    admitted: Schema.Literal(false),
    reason: Schema.String,
    detail: Schema.optionalKey(Schema.String),
  }),
])

export const agentHostUnitName = (runId: string) =>
  `workflowd-native-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}.service`

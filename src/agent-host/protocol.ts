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
    "codex-discovery",
  ]),
  directory: Schema.String,
  prompt: HostText,
  model: Schema.NullOr(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  nativeSessionId: Schema.optionalKey(HostId),
})
export type HostStart = typeof HostStart.Type
export const HostRequest = Schema.Union([
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
})
export type OwnedProcess = typeof OwnedProcess.Type
export const HostResponse = Schema.Union([
  Schema.Struct({ admitted: Schema.Literal(true), process: Schema.NullOr(OwnedProcess) }),
  Schema.Struct({ admitted: Schema.Literal(true), bytes: Schema.String }),
  Schema.Struct({ admitted: Schema.Literal(false), reason: Schema.String }),
])

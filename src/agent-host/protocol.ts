import { Schema } from "effect"

export const CredentialAdmissionReason = Schema.Literals([
  "shared_credential_link_broken",
  "shared_credential_diverged",
  "shared_credential_permissions_invalid",
  "credential_relink_in_progress",
  "opencode_grant_migration_incomplete",
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

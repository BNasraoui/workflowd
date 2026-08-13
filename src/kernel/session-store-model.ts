import type { JsonValue } from "../json"

export const MAX_CUSTODY_ID_BYTES = 256
export const MAX_CUSTODY_PATH_BYTES = 4096
export const MAX_CUSTODY_JSON_BYTES = 65_536
export const MAX_CUSTODY_TEXT_BYTES = 65_536

export type ProviderKind = "opencode" | "codex" | "claude"
export type ResourceKind = "workspace" | "worktree" | "checkout"
/**
 * `reserved` is usable host custody. `cleanup_required` is fenced pending janitor work.
 * `cleanup_leased` has active janitor authority. `cleaned` and `missing` are terminal.
 * `operator_required` and `data_error` remain fenced for intervention.
 */
export type ResourceState =
  | "reserved"
  | "cleanup_required"
  | "cleanup_leased"
  | "cleaned"
  | "missing"
  | "operator_required"
  | "data_error"
export type ResumeState =
  | "ready"
  | "leased"
  | "sent"
  | "observation_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "operator_required"
  | "data_error"

/**
 * `ready` is registered and idle. `active` has claimed work. `completed` and `missing` are terminal
 * provider observations. `cleanup_required` and `cleaned` follow resource custody cleanup.
 * `operator_required` and `data_error` remain fenced for intervention.
 */
export type SessionState =
  | "ready"
  | "active"
  | "completed"
  | "missing"
  | "cleanup_required"
  | "cleaned"
  | "operator_required"
  | "data_error"

export type ResumeAuthority = {
  readonly requestId: string
  readonly attempt: number
  readonly owningHostId: string
  readonly workerId: string
  readonly claimToken: string
  readonly expectedLeaseUntil: Date
  readonly now: Date
}
export type ResumeClaim = Omit<ResumeAuthority, "expectedLeaseUntil" | "now"> & {
  readonly sessionId: string
  readonly prompt: JsonValue
  readonly promptText: string
  readonly outputContract: string | null
  readonly outputContractVersion: number | null
  readonly maxAttempts: number
  readonly leaseUntil: Date
}
export type CleanupAuthority = {
  readonly cleanupId: string
  readonly attempt: number
  readonly owningHostId: string
  readonly workerId: string
  readonly claimToken: string
  readonly expectedLeaseUntil: Date
  readonly now: Date
}
export type CleanupClaim = Omit<CleanupAuthority, "expectedLeaseUntil" | "now"> & {
  readonly resourceId: string
  readonly reason: string
  readonly maxAttempts: number
  readonly leaseUntil: Date
}

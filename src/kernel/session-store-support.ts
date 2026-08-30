import { Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import { MAX_CUSTODY_ID_BYTES } from "./session-store-model"

export const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const compareKeys = ([left]: [string, JsonValue], [right]: [string, JsonValue]) => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(compareKeys)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export const Timestamp = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)),
)
export const JsonText = Schema.fromJsonString(JsonValueSchema)
export const ResourceReadRow = Schema.Struct({
  resource_id: Schema.String,
  owning_host_id: Schema.String,
  absolute_path: Schema.String,
  kind: Schema.Literals(["workspace", "worktree", "checkout"]),
  state: Schema.Literals([
    "reserved",
    "cleanup_required",
    "cleanup_leased",
    "cleaned",
    "missing",
    "operator_required",
    "data_error",
  ]),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export const SessionReadRow = Schema.Struct({
  session_id: Schema.String,
  provider_kind: Schema.Literals(["opencode", "codex", "claude"]),
  provider_version: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  owning_host_id: Schema.String,
  resource_id: Schema.String,
  state: Schema.Literals([
    "ready",
    "active",
    "completed",
    "missing",
    "cleanup_required",
    "cleaned",
    "operator_required",
    "data_error",
  ]),
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export const ResumeReadRow = Schema.Struct({
  request_id: Schema.String,
  session_id: Schema.String,
  owning_host_id: Schema.String,
  prompt_json: JsonText,
  prompt_text: Schema.String,
  prompt_sha256: Schema.String,
  state: Schema.Literals([
    "ready",
    "leased",
    "sent",
    "observation_required",
    "completed",
    "failed",
    "cancelled",
    "operator_required",
    "data_error",
  ]),
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  max_attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  run_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
})
export const CleanupReadRow = Schema.Struct({
  cleanup_id: Schema.String,
  resource_id: Schema.String,
  owning_host_id: Schema.String,
  reason: Schema.String,
  state: Schema.Literals([
    "pending",
    "leased",
    "completed",
    "missing",
    "retry_scheduled",
    "operator_required",
    "data_error",
  ]),
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  max_attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  run_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
})
export const ObservationReadRow = Schema.Struct({
  observation_id: Schema.String,
  request_id: Schema.String,
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  observer_host_id: Schema.String,
  observer_worker_id: Schema.String,
  observer_token: Schema.String,
  disposition: Schema.Literals(["completed", "missing", "failed", "operator_required"]),
  evidence_version: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  evidence_json: JsonText,
  observed_at: Timestamp,
})

export const checkTextValue = (value: string, max = MAX_CUSTODY_ID_BYTES) =>
  value.length > 0 && bytes(value) <= max
export const positiveValue = (value: number) => Number.isInteger(value) && value > 0
export const validDateValue = (value: Date) =>
  value instanceof Date && Number.isFinite(value.getTime())

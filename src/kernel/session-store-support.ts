import { Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import { MAX_CUSTODY_ID_BYTES } from "./session-store-model"

export const bytes = (value: string) => new TextEncoder().encode(value).byteLength
export const canonicalJson = (value: JsonValue): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
          .join(",")}}`
      : JSON.stringify(value)

export const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
)
export const JsonText = Schema.parseJson(JsonValueSchema)
export const ResourceReadRow = Schema.Struct({
  resource_id: Schema.String,
  owning_host_id: Schema.String,
  absolute_path: Schema.String,
  kind: Schema.Literal("workspace", "worktree", "checkout"),
  state: Schema.Literal(
    "reserved",
    "cleanup_required",
    "cleanup_leased",
    "cleaned",
    "missing",
    "operator_required",
    "data_error",
  ),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export const SessionReadRow = Schema.Struct({
  session_id: Schema.String,
  provider_kind: Schema.Literal("opencode", "codex", "claude"),
  provider_version: Schema.Int.pipe(Schema.positive()),
  owning_host_id: Schema.String,
  resource_id: Schema.String,
  state: Schema.Literal(
    "ready",
    "active",
    "completed",
    "missing",
    "cleanup_required",
    "cleaned",
    "operator_required",
    "data_error",
  ),
  revision: Schema.Int.pipe(Schema.positive()),
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
  state: Schema.Literal(
    "ready",
    "leased",
    "sent",
    "observation_required",
    "completed",
    "failed",
    "cancelled",
    "operator_required",
    "data_error",
  ),
  attempt: Schema.Int.pipe(Schema.nonNegative()),
  max_attempts: Schema.Int.pipe(Schema.positive()),
  run_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
})
export const CleanupReadRow = Schema.Struct({
  cleanup_id: Schema.String,
  resource_id: Schema.String,
  owning_host_id: Schema.String,
  reason: Schema.String,
  state: Schema.Literal(
    "pending",
    "leased",
    "completed",
    "missing",
    "retry_scheduled",
    "operator_required",
    "data_error",
  ),
  attempt: Schema.Int.pipe(Schema.nonNegative()),
  max_attempts: Schema.Int.pipe(Schema.positive()),
  run_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
})
export const ObservationReadRow = Schema.Struct({
  observation_id: Schema.String,
  request_id: Schema.String,
  attempt: Schema.Int.pipe(Schema.positive()),
  observer_host_id: Schema.String,
  observer_worker_id: Schema.String,
  observer_token: Schema.String,
  disposition: Schema.Literal("completed", "missing", "failed", "operator_required"),
  evidence_version: Schema.Int.pipe(Schema.positive()),
  evidence_json: JsonText,
  observed_at: Timestamp,
})

export const checkTextValue = (value: string, max = MAX_CUSTODY_ID_BYTES) =>
  value.length > 0 && bytes(value) <= max
export const positiveValue = (value: number) => Number.isInteger(value) && value > 0
export const validDateValue = (value: Date) =>
  value instanceof Date && Number.isFinite(value.getTime())

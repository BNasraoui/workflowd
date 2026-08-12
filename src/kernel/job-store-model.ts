import { Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"

export const MAX_KERNEL_JOB_IDENTIFIER_BYTES = 256
export const MAX_KERNEL_JOB_PAYLOAD_BYTES = 65_536

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const boundedText = (bytes: number) =>
  Schema.NonEmptyString.pipe(
    Schema.filter((value) => utf8Bytes(value) <= bytes, {
      message: () => `must be at most ${bytes} UTF-8 bytes`,
    }),
  )

export const JobIdentifier = boundedText(MAX_KERNEL_JOB_IDENTIFIER_BYTES)
export const JobVersion = Schema.Int.pipe(Schema.positive())

export const EnqueueJobInput = Schema.Struct({
  jobId: JobIdentifier,
  instanceId: JobIdentifier,
  waitId: JobIdentifier,
  eventSequence: Schema.Int.pipe(Schema.positive()),
  expectedCursor: Schema.Int.pipe(Schema.nonNegative()),
  inputVersion: JobVersion,
  input: JsonValueSchema,
  maxAttempts: Schema.Int.pipe(Schema.positive()),
  runAt: Schema.DateFromSelf,
  createdAt: Schema.DateFromSelf,
})
export type EnqueueJobInput = typeof EnqueueJobInput.Type

export type JobState =
  | "ready"
  | "leased"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "operator_required"
  | "data_error"

export type JobClaim = {
  readonly jobId: string
  readonly instanceId: string
  readonly inputVersion: number
  readonly input: JsonValue
  readonly workerId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly claimToken: string
  readonly leaseUntil: Date
}

export type JobRecord = {
  readonly jobId: string
  readonly instanceId: string
  readonly state: JobState
  readonly attempt: number
  readonly maxAttempts: number
  readonly runAt: Date
  readonly leaseUntil: Date | null
}

export type JobResult = {
  readonly resultId: string
  readonly jobId: string
  readonly resultVersion: number
  readonly result: JsonValue
  readonly completedAt: Date
}

export type ClaimAuthority = {
  readonly jobId: string
  readonly workerId: string
  readonly attempt: number
  readonly claimToken: string
  readonly expectedLeaseUntil: Date
  readonly now: Date
}

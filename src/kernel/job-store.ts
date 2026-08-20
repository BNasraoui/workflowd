import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { JsonValueSchema } from "../json"
import {
  KernelEventStore,
  KernelEventStoreLive,
  type KernelStoreConflictError,
  type KernelStoreDataError,
  type KernelStoreInputError,
} from "./event-store"
import { jobCompletionEvent } from "./job-completion-contract"
import {
  type ClaimAuthority,
  type EnqueueJobInput,
  EnqueueJobInput as EnqueueJobInputSchema,
  type JobClaim,
  JobIdentifier,
  type JobRecord,
  type JobResult,
  JobVersion,
  MAX_KERNEL_JOB_PAYLOAD_BYTES,
} from "./job-store-model"

export * from "./job-store-model"

export class KernelJobStoreInputError extends Data.TaggedError("KernelJobStoreInputError")<{
  readonly message: string
}> {}
export class KernelJobStoreConflictError extends Data.TaggedError("KernelJobStoreConflictError")<{
  readonly record: "delivery" | "job" | "result"
  readonly key: string
}> {}
export class KernelJobStoreLeaseError extends Data.TaggedError("KernelJobStoreLeaseError")<{
  readonly jobId: string
}> {}
export class KernelJobStoreDataError extends Data.TaggedError("KernelJobStoreDataError")<{
  readonly record: "job" | "result"
  readonly key: string
  readonly message: string
}> {}

export type KernelJobStoreError =
  | SqlError
  | KernelStoreConflictError
  | KernelStoreDataError
  | KernelStoreInputError
  | KernelJobStoreConflictError
  | KernelJobStoreDataError
  | KernelJobStoreInputError
  | KernelJobStoreLeaseError

type ClaimInput = {
  readonly workerId: string
  readonly now: Date
  readonly leaseDurationMs: number
}
type FailureInput = ClaimAuthority & {
  readonly failureVersion: number
  readonly failure: unknown
  readonly category?: "transient" | "permanent" | "operator_required"
}
type RetryInput = FailureInput & { readonly runAt: Date }
type CompleteInput = ClaimAuthority & {
  readonly resultId: string
  readonly resultVersion: number
  readonly result: unknown
}

export type KernelJobStorePort = {
  readonly enqueueFromDelivery: (
    input: EnqueueJobInput,
  ) => Effect.Effect<
    { readonly status: "enqueued" | "duplicate"; readonly eventCursor: number },
    KernelJobStoreError
  >
  readonly claimNext: (input: ClaimInput) => Effect.Effect<JobClaim | null, KernelJobStoreError>
  readonly claimRemoteProbe: (
    input: ClaimInput,
  ) => Effect.Effect<JobClaim | null, KernelJobStoreError>
  readonly heartbeat: (
    input: ClaimAuthority & { readonly leaseDurationMs: number },
  ) => Effect.Effect<{ readonly leaseUntil: Date }, KernelJobStoreError>
  readonly complete: (
    input: CompleteInput,
  ) => Effect.Effect<{ readonly status: "completed" | "duplicate" }, KernelJobStoreError>
  readonly fail: (
    input: FailureInput,
  ) => Effect.Effect<{ readonly status: "failed" | "operator_required" }, KernelJobStoreError>
  readonly retry: (input: RetryInput) => Effect.Effect<
    {
      readonly status: "retry_scheduled" | "failed"
      readonly attempt: number
      readonly runAt?: Date
    },
    KernelJobStoreError
  >
  readonly readJob: (jobId: string) => Effect.Effect<JobRecord | null, KernelJobStoreError>
  readonly readResult: (jobId: string) => Effect.Effect<JobResult | null, KernelJobStoreError>
  readonly readRecoverable: () => Effect.Effect<ReadonlyArray<JobRecord>, KernelJobStoreError>
}

export const KernelJobStore = Context.GenericTag<KernelJobStorePort>(
  "workflowd/kernel/KernelJobStore",
)

const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
)
const JsonText = Schema.parseJson(JsonValueSchema)
const JobState = Schema.Literal(
  "ready",
  "leased",
  "retry_scheduled",
  "succeeded",
  "failed",
  "operator_required",
  "data_error",
)
const JobRow = Schema.Struct({
  job_id: JobIdentifier,
  instance_id: JobIdentifier,
  wait_id: JobIdentifier,
  event_sequence: Schema.Int.pipe(Schema.positive()),
  expected_cursor: Schema.Int.pipe(Schema.nonNegative()),
  input_version: JobVersion,
  input_json: JsonText,
  state: JobState,
  attempt: Schema.Int.pipe(Schema.nonNegative()),
  max_attempts: JobVersion,
  run_at: Timestamp,
  created_at: Timestamp,
  lease_worker_id: Schema.NullOr(JobIdentifier),
  claim_token: Schema.NullOr(JobIdentifier),
  lease_until: Schema.NullOr(Timestamp),
})
const ResultRow = Schema.Struct({
  result_id: JobIdentifier,
  job_id: JobIdentifier,
  attempt: JobVersion,
  worker_id: JobIdentifier,
  claim_token: JobIdentifier,
  lease_until: Timestamp,
  result_version: JobVersion,
  result_json: JsonText,
  completed_at: Timestamp,
})

const compareJsonEntries = ([left]: [string, unknown], [right]: [string, unknown]): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(compareJsonEntries)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
const inputError = (error: unknown) => new KernelJobStoreInputError({ message: String(error) })
const dataError = (record: "job" | "result", key: string) => (error: unknown) =>
  new KernelJobStoreDataError({ record, key, message: String(error) })
const boundedJson = (value: unknown) =>
  Schema.decodeUnknown(JsonValueSchema)(value).pipe(
    Effect.mapError(inputError),
    Effect.flatMap((decoded) => {
      const json = canonicalJson(decoded)
      return new TextEncoder().encode(json).byteLength <= MAX_KERNEL_JOB_PAYLOAD_BYTES
        ? Effect.succeed({ decoded, json })
        : Effect.fail(new KernelJobStoreInputError({ message: "payload exceeds 65536 bytes" }))
    }),
  )
const positiveDuration = (value: number) =>
  Schema.decodeUnknown(Schema.Int.pipe(Schema.positive()))(value).pipe(Effect.mapError(inputError))

const toRecord = (row: typeof JobRow.Type): JobRecord => ({
  jobId: row.job_id,
  instanceId: row.instance_id,
  state: row.state,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  runAt: new Date(row.run_at),
  leaseUntil: row.lease_until === null ? null : new Date(row.lease_until),
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`PRAGMA busy_timeout = 5000`

  const decodeJob = (row: unknown, key: string) =>
    Schema.decodeUnknown(JobRow)(row).pipe(Effect.mapError(dataError("job", key)))
  const decodeResult = (row: unknown, key: string) =>
    Schema.decodeUnknown(ResultRow)(row).pipe(Effect.mapError(dataError("result", key)))

  const enqueueFromDelivery: KernelJobStorePort["enqueueFromDelivery"] = (input) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(EnqueueJobInputSchema)(input).pipe(
        Effect.mapError(inputError),
      )
      const payload = yield* boundedJson(decoded.input)
      const existing =
        yield* sql`SELECT * FROM kernel_workflow_jobs WHERE job_id = ${decoded.jobId}`
      if (existing.length > 0) {
        const row = yield* decodeJob(existing[0], decoded.jobId)
        const exact =
          row.instance_id === decoded.instanceId &&
          row.wait_id === decoded.waitId &&
          row.event_sequence === decoded.eventSequence &&
          row.expected_cursor === decoded.expectedCursor &&
          row.input_version === decoded.inputVersion &&
          canonicalJson(row.input_json) === payload.json &&
          row.max_attempts === decoded.maxAttempts &&
          row.run_at === decoded.runAt.toISOString() &&
          row.created_at === decoded.createdAt.toISOString()
        if (!exact) {
          return yield* new KernelJobStoreConflictError({ record: "job", key: decoded.jobId })
        }
        return { status: "duplicate" as const, eventCursor: row.event_sequence }
      }
      const inserted = yield* sql`
        INSERT INTO kernel_workflow_jobs (
          job_id, instance_id, wait_id, event_sequence, expected_cursor, input_version,
          input_json, state, attempt, max_attempts, run_at, created_at, updated_at
        )
        SELECT ${decoded.jobId}, ${decoded.instanceId}, ${decoded.waitId},
          ${decoded.eventSequence}, ${decoded.expectedCursor}, ${decoded.inputVersion},
          ${payload.json}, 'ready', 0, ${decoded.maxAttempts},
          ${decoded.runAt.toISOString()}, ${decoded.createdAt.toISOString()},
          ${decoded.createdAt.toISOString()}
        FROM kernel_workflow_instances AS instance
        WHERE instance.instance_id = ${decoded.instanceId}
          AND instance.event_cursor = ${decoded.expectedCursor}
          AND EXISTS (
            SELECT 1 FROM kernel_wait_event_deliveries AS delivery
            JOIN kernel_waits AS wait ON wait.instance_id = delivery.instance_id
              AND wait.wait_id = delivery.wait_id
            WHERE delivery.instance_id = ${decoded.instanceId}
              AND delivery.wait_id = ${decoded.waitId}
              AND delivery.event_sequence = ${decoded.eventSequence}
              AND delivery.state = 'ready' AND wait.state = 'matched'
          )
        ON CONFLICT (job_id) DO NOTHING
        RETURNING job_id
      `
      if (inserted.length === 0) {
        return yield* new KernelJobStoreConflictError({ record: "delivery", key: decoded.waitId })
      }
      yield* sql`UPDATE kernel_workflow_instances SET event_cursor = ${decoded.eventSequence}
        WHERE instance_id = ${decoded.instanceId} AND event_cursor = ${decoded.expectedCursor}`
      yield* sql`UPDATE kernel_wait_event_deliveries SET state = 'consumed'
        WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}
          AND event_sequence = ${decoded.eventSequence} AND state = 'ready'`
      yield* sql`UPDATE kernel_waits SET state = 'consumed'
        WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}
          AND state = 'matched'`
      return { status: "enqueued" as const, eventCursor: decoded.eventSequence }
    }).pipe(sql.withTransaction)

  const quarantine = (jobId: string, now: string, message: string) =>
    sql`UPDATE kernel_workflow_jobs SET state = 'data_error', lease_worker_id = NULL,
      claim_token = NULL, lease_until = NULL, failure_category = 'data_error',
      failure_version = 1, failure_json = ${canonicalJson({ message })}, updated_at = ${now}
      WHERE job_id = ${jobId}`

  const claimMatching = (remoteProbe: boolean, input: ClaimInput) =>
    Effect.gen(function* () {
      const workerId = yield* Schema.decodeUnknown(JobIdentifier)(input.workerId).pipe(
        Effect.mapError(inputError),
      )
      const duration = yield* positiveDuration(input.leaseDurationMs)
      const nowText = input.now.toISOString()
      const candidates = yield* sql<{ readonly job_id: string }>`SELECT job_id
        FROM kernel_workflow_jobs
        WHERE ((state IN ('ready', 'retry_scheduled') AND run_at <= ${nowText})
          OR (state = 'leased' AND lease_until <= ${nowText}))
        AND (
          (${remoteProbe ? 1 : 0} = 1 AND CASE WHEN json_valid(input_json)
            THEN json_extract(input_json, '$.kind') ELSE NULL END = 'remote_probe')
          OR (${remoteProbe ? 1 : 0} = 0
            AND CASE WHEN json_valid(input_json)
              THEN COALESCE(json_extract(input_json, '$.kind'), '') ELSE '' END <> 'remote_probe')
        )
        AND NOT EXISTS (
          SELECT 1 FROM kernel_remote_dispatches AS dispatch
          WHERE dispatch.job_id = kernel_workflow_jobs.job_id
            AND dispatch.attempt = kernel_workflow_jobs.attempt
            AND dispatch.state IN ('prepared', 'publishing', 'published')
        )
        ORDER BY run_at, job_id`
      for (const candidate of candidates) {
        const exhausted = yield* sql`UPDATE kernel_workflow_jobs SET state = 'failed',
          lease_worker_id = NULL, claim_token = NULL, lease_until = NULL,
          failure_category = 'transient', failure_version = 1,
          failure_json = ${canonicalJson({ message: "lease expired after final attempt" })},
          updated_at = ${nowText}
          WHERE job_id = ${candidate.job_id} AND state = 'leased'
            AND lease_until <= ${nowText} AND attempt >= max_attempts RETURNING job_id`
        if (exhausted.length > 0) continue
        const token = randomUUID()
        const leaseUntil = new Date(input.now.getTime() + duration).toISOString()
        const rows = yield* sql`UPDATE kernel_workflow_jobs
          SET state = 'leased', attempt = attempt + 1, lease_worker_id = ${workerId},
            claim_token = ${token}, lease_until = ${leaseUntil}, updated_at = ${nowText}
          WHERE job_id = ${candidate.job_id}
            AND attempt < max_attempts
            AND (
              (${remoteProbe ? 1 : 0} = 1 AND CASE WHEN json_valid(input_json)
                THEN json_extract(input_json, '$.kind') ELSE NULL END = 'remote_probe')
              OR (${remoteProbe ? 1 : 0} = 0
                AND CASE WHEN json_valid(input_json)
                  THEN COALESCE(json_extract(input_json, '$.kind'), '') ELSE '' END <> 'remote_probe')
            )
            AND NOT EXISTS (
              SELECT 1 FROM kernel_remote_dispatches AS dispatch
              WHERE dispatch.job_id = kernel_workflow_jobs.job_id
                AND dispatch.attempt = kernel_workflow_jobs.attempt
                AND dispatch.state IN ('prepared', 'publishing', 'published')
            )
            AND ((state IN ('ready', 'retry_scheduled') AND run_at <= ${nowText})
              OR (state = 'leased' AND lease_until <= ${nowText}))
          RETURNING job_id, instance_id, wait_id, event_sequence, expected_cursor,
            input_version, input_json, state, attempt, max_attempts, run_at, created_at,
            lease_worker_id, claim_token, lease_until`
        if (rows.length === 0) continue
        const decoded = yield* decodeJob(rows[0], candidate.job_id).pipe(Effect.either)
        if (decoded._tag === "Left") {
          yield* quarantine(candidate.job_id, nowText, decoded.left.message)
          continue
        }
        return {
          jobId: decoded.right.job_id,
          instanceId: decoded.right.instance_id,
          inputVersion: decoded.right.input_version,
          input: decoded.right.input_json,
          workerId,
          attempt: decoded.right.attempt,
          maxAttempts: decoded.right.max_attempts,
          claimToken: token,
          leaseUntil: new Date(leaseUntil),
        }
      }
      return null
    }).pipe(sql.withTransaction)

  const claimNext: KernelJobStorePort["claimNext"] = (input) => claimMatching(false, input)
  const claimRemoteProbe: KernelJobStorePort["claimRemoteProbe"] = (input) =>
    claimMatching(true, input)

  const authorityWhere = (input: ClaimAuthority) => sql`
    job_id = ${input.jobId} AND state = 'leased' AND attempt = ${input.attempt}
    AND lease_worker_id = ${input.workerId} AND claim_token = ${input.claimToken}
    AND lease_until = ${input.expectedLeaseUntil.toISOString()}
    AND lease_until > ${input.now.toISOString()}
  `
  const leaseFailure = (jobId: string) => new KernelJobStoreLeaseError({ jobId })

  const heartbeat: KernelJobStorePort["heartbeat"] = (input) =>
    Effect.gen(function* () {
      const duration = yield* positiveDuration(input.leaseDurationMs)
      const leaseUntil = new Date(input.now.getTime() + duration)
      const rows = yield* sql`UPDATE kernel_workflow_jobs
        SET lease_until = ${leaseUntil.toISOString()}, updated_at = ${input.now.toISOString()}
        WHERE ${authorityWhere(input)} RETURNING job_id`
      if (rows.length === 0) return yield* leaseFailure(input.jobId)
      return { leaseUntil }
    }).pipe(sql.withTransaction)

  const readStoredResult = (jobId: string) =>
    sql`SELECT * FROM kernel_workflow_job_results WHERE job_id = ${jobId}`

  const complete: KernelJobStorePort["complete"] = (input) =>
    Effect.gen(function* () {
      const resultId = yield* Schema.decodeUnknown(JobIdentifier)(input.resultId).pipe(
        Effect.mapError(inputError),
      )
      const version = yield* Schema.decodeUnknown(JobVersion)(input.resultVersion).pipe(
        Effect.mapError(inputError),
      )
      const payload = yield* boundedJson(input.result)
      const stored = yield* readStoredResult(input.jobId)
      if (stored.length > 0) {
        const row = yield* decodeResult(stored[0], input.jobId)
        if (
          row.attempt !== input.attempt ||
          row.worker_id !== input.workerId ||
          row.claim_token !== input.claimToken ||
          row.lease_until !== input.expectedLeaseUntil.toISOString()
        ) {
          return yield* leaseFailure(input.jobId)
        }
        if (
          row.result_id === resultId &&
          row.result_version === version &&
          canonicalJson(row.result_json) === payload.json
        ) {
          return { status: "duplicate" as const }
        }
        return yield* new KernelJobStoreConflictError({ record: "result", key: resultId })
      }
      const identity = yield* sql`SELECT job_id FROM kernel_workflow_job_results
        WHERE result_id = ${resultId}`
      if (identity.length > 0) {
        return yield* new KernelJobStoreConflictError({ record: "result", key: resultId })
      }
      const updated = yield* sql`UPDATE kernel_workflow_jobs SET state = 'succeeded',
        lease_worker_id = NULL, claim_token = NULL, lease_until = NULL,
        updated_at = ${input.now.toISOString()} WHERE ${authorityWhere(input)} RETURNING job_id`
      if (updated.length === 0) {
        const completed =
          yield* sql`SELECT state FROM kernel_workflow_jobs WHERE job_id = ${input.jobId}`
        if ((completed[0] as { state?: string } | undefined)?.state === "succeeded") {
          return yield* new KernelJobStoreConflictError({ record: "result", key: resultId })
        }
        return yield* leaseFailure(input.jobId)
      }
      yield* sql`INSERT INTO kernel_workflow_job_results (
        result_id, job_id, attempt, worker_id, claim_token, lease_until,
        result_version, result_json, completed_at
      ) VALUES (
        ${resultId}, ${input.jobId}, ${input.attempt}, ${input.workerId},
        ${input.claimToken}, ${input.expectedLeaseUntil.toISOString()}, ${version},
        ${payload.json}, ${input.now.toISOString()}
      )`
      yield* events.recordEvent(
        jobCompletionEvent({
          jobId: input.jobId,
          outcome: "succeeded",
          resultId,
          resultVersion: version,
          completedAt: input.now.toISOString(),
        }),
      )
      return { status: "completed" as const }
    }).pipe(sql.withTransaction)

  const failurePayload = (input: FailureInput) =>
    Effect.all({
      version: Schema.decodeUnknown(JobVersion)(input.failureVersion).pipe(
        Effect.mapError(inputError),
      ),
      payload: boundedJson(input.failure),
    })

  const fail: KernelJobStorePort["fail"] = (input) =>
    Effect.gen(function* () {
      const { version, payload } = yield* failurePayload(input)
      const state: "failed" | "operator_required" =
        input.category === "operator_required" ? "operator_required" : "failed"
      const category = input.category ?? "permanent"
      const rows = yield* sql`UPDATE kernel_workflow_jobs SET state = ${state},
        lease_worker_id = NULL, claim_token = NULL, lease_until = NULL,
        failure_category = ${category}, failure_version = ${version},
        failure_json = ${payload.json}, updated_at = ${input.now.toISOString()}
        WHERE ${authorityWhere(input)} RETURNING job_id`
      if (rows.length === 0) return yield* leaseFailure(input.jobId)
      yield* events.recordEvent(
        jobCompletionEvent({
          jobId: input.jobId,
          outcome: state,
          failureCategory: category,
          failureVersion: version,
          completedAt: input.now.toISOString(),
        }),
      )
      return { status: state }
    }).pipe(sql.withTransaction)

  const retry: KernelJobStorePort["retry"] = (input) =>
    Effect.gen(function* () {
      const { version, payload } = yield* failurePayload(input)
      const attempts = yield* sql<{ readonly attempt: number; readonly max_attempts: number }>`
        SELECT attempt, max_attempts FROM kernel_workflow_jobs WHERE ${authorityWhere(input)}`
      if (attempts.length === 0) return yield* leaseFailure(input.jobId)
      const exhausted = attempts[0]!.attempt >= attempts[0]!.max_attempts
      const state = exhausted ? "failed" : "retry_scheduled"
      yield* sql`UPDATE kernel_workflow_jobs SET state = ${state},
        run_at = ${input.runAt.toISOString()}, lease_worker_id = NULL, claim_token = NULL,
        lease_until = NULL, failure_category = 'transient', failure_version = ${version},
        failure_json = ${payload.json}, updated_at = ${input.now.toISOString()}
        WHERE ${authorityWhere(input)}`
      if (exhausted) {
        yield* events.recordEvent(
          jobCompletionEvent({
            jobId: input.jobId,
            outcome: "failed",
            failureCategory: "transient",
            failureVersion: version,
            completedAt: input.now.toISOString(),
          }),
        )
      }
      return exhausted
        ? { status: "failed" as const, attempt: attempts[0]!.attempt }
        : { status: "retry_scheduled" as const, attempt: attempts[0]!.attempt, runAt: input.runAt }
    }).pipe(sql.withTransaction)

  const readJob: KernelJobStorePort["readJob"] = (jobId) =>
    Effect.gen(function* () {
      const key = yield* Schema.decodeUnknown(JobIdentifier)(jobId).pipe(
        Effect.mapError(inputError),
      )
      const rows = yield* sql`SELECT job_id, instance_id, wait_id, event_sequence,
        expected_cursor, input_version, input_json, state, attempt, max_attempts, run_at,
        created_at, lease_worker_id, claim_token, lease_until
        FROM kernel_workflow_jobs WHERE job_id = ${key}`
      return rows.length === 0 ? null : toRecord(yield* decodeJob(rows[0], key))
    })
  const readResult: KernelJobStorePort["readResult"] = (jobId) =>
    Effect.gen(function* () {
      const rows = yield* readStoredResult(jobId)
      if (rows.length === 0) return null
      const row = yield* decodeResult(rows[0], jobId)
      return {
        resultId: row.result_id,
        jobId: row.job_id,
        resultVersion: row.result_version,
        result: row.result_json,
        completedAt: new Date(row.completed_at),
      }
    })
  const readRecoverable: KernelJobStorePort["readRecoverable"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT job_id, instance_id, wait_id, event_sequence,
        expected_cursor, input_version, input_json, state, attempt, max_attempts, run_at,
        created_at, lease_worker_id, claim_token, lease_until
        FROM kernel_workflow_jobs WHERE state IN ('ready', 'retry_scheduled', 'leased')
        ORDER BY run_at, job_id`
      return yield* Effect.forEach(rows, (row) =>
        decodeJob(row, (row as { job_id?: string }).job_id ?? "unknown").pipe(Effect.map(toRecord)),
      )
    })

  return KernelJobStore.of({
    enqueueFromDelivery,
    claimNext,
    claimRemoteProbe,
    heartbeat,
    complete,
    fail,
    retry,
    readJob,
    readResult,
    readRecoverable,
  })
})

/** Requires the shared WorkflowStore migration bootstrap. */
export const KernelJobStoreLive = Layer.effect(KernelJobStore, make).pipe(
  Layer.provideMerge(KernelEventStoreLive),
)

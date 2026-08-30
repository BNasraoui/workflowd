import { createHash } from "node:crypto"
import { SqlClient } from "effect/unstable/sql"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import { KernelEventStore } from "./event-store"
import {
  KernelJobStore,
  KernelJobStoreDataError,
  type JobState,
  type KernelJobStoreError,
} from "./job-store"
import type {
  KernelStoreConflictError,
  KernelStoreDataError,
  KernelStoreInputError,
} from "./event-store"
import type { SqlError } from "effect/unstable/sql/SqlError"

export const MAX_TEST_JOB_ID_BYTES = 128

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
export const TestJobId = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) => utf8Bytes(value) <= MAX_TEST_JOB_ID_BYTES, {
      message: `must be at most ${MAX_TEST_JOB_ID_BYTES} UTF-8 bytes`,
    }),
  ),
  Schema.check(
    Schema.makeFilter((value) => value !== "." && value !== "..", {
      message: "must not be a URL dot segment",
    }),
  ),
)

export const TestJobSubmission = Schema.Struct({
  jobId: TestJobId,
  value: JsonValueSchema,
})
export type TestJobSubmission = typeof TestJobSubmission.Type

const TestJobResult = Schema.Struct({
  kind: Schema.Literal("echo"),
  value: JsonValueSchema,
})

export type TestJobStatusName =
  "pending" | "running" | "retrying" | "succeeded" | "failed" | "operator-required" | "data-error"

export type TestJobStatus = {
  readonly jobId: string
  readonly status: TestJobStatusName
  readonly result?: JsonValue
}

export class TestJobCanaryNotFound extends Data.TaggedError("TestJobCanaryNotFound")<{
  readonly jobId: string
}> {}
export class TestJobCanaryConflict extends Data.TaggedError("TestJobCanaryConflict")<{
  readonly jobId: string
}> {}

export type TestJobCanaryPort = {
  readonly submit: (
    input: TestJobSubmission,
    now: Date,
  ) => Effect.Effect<TestJobStatus & { readonly newlyEnqueued: boolean }, TestJobCanaryError>
  readonly status: (jobId: string) => Effect.Effect<TestJobStatus, TestJobCanaryError>
}

export type TestJobCanaryError =
  | SqlError
  | KernelStoreConflictError
  | KernelStoreDataError
  | KernelStoreInputError
  | KernelJobStoreError
  | TestJobCanaryConflict
  | TestJobCanaryNotFound
  | Schema.SchemaError

export const TestJobCanary = Context.Service<TestJobCanaryPort>("workflowd/kernel/TestJobCanary")

const identifiers = (jobId: string) => {
  const digest = createHash("sha256").update(jobId, "utf8").digest("hex")
  return {
    instanceId: `test-job-instance-${digest}`,
    waitId: `test-job-wait-${digest}`,
    eventId: `test-job-event-${digest}`,
    kernelJobId: `test-job-${digest}`,
  }
}

const publicStatus = (state: JobState): TestJobStatusName => {
  switch (state) {
    case "ready":
      return "pending"
    case "leased":
      return "running"
    case "retry_scheduled":
      return "retrying"
    case "succeeded":
    case "failed":
      return state
    case "operator_required":
      return "operator-required"
    case "data_error":
      return "data-error"
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore
  const jobs = yield* KernelJobStore

  const status: TestJobCanaryPort["status"] = (jobId) =>
    Effect.gen(function* () {
      const decodedId = yield* Schema.decodeUnknownEffect(TestJobId)(jobId)
      const job = yield* jobs.readJob(identifiers(decodedId).kernelJobId)
      if (job === null) return yield* new TestJobCanaryNotFound({ jobId: decodedId })
      const state = publicStatus(job.state)
      if (state !== "succeeded") return { jobId: decodedId, status: state }
      const result = yield* jobs.readResult(job.jobId)
      if (result === null || result.resultVersion !== 1) {
        return yield* new KernelJobStoreDataError({
          record: "result",
          key: job.jobId,
          message: result === null ? "succeeded job has no result" : "unsupported result version",
        })
      }
      const decoded = yield* Schema.decodeUnknownEffect(TestJobResult)(result.result, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          (error) =>
            new KernelJobStoreDataError({
              record: "result",
              key: job.jobId,
              message: String(error),
            }),
        ),
      )
      return { jobId: decodedId, status: state, result: decoded.value }
    })

  const submit: TestJobCanaryPort["submit"] = (input, now) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(TestJobSubmission)(input, {
        onExcessProperty: "error",
      })
      const ids = identifiers(decoded.jobId)
      const instance = yield* events.createInstance({
        instanceId: ids.instanceId,
        workflowType: "test-job-canary",
        workflowVersion: 1,
        workflowKey: ids.kernelJobId,
        payload: decoded.value,
        createdAt: now,
      })
      const condition = {
        type: "test-job-canary-submitted",
        version: 1,
        key: ids.kernelJobId,
        correlation: ids.kernelJobId,
      } as const
      const wait = yield* events.registerWait({
        instanceId: ids.instanceId,
        waitId: ids.waitId,
        condition,
        registeredAt: instance.instance.createdAt,
      })
      const recorded = yield* events.recordEvent({
        source: "test-job-canary",
        sourceEventId: ids.eventId,
        event: { ...condition, payload: decoded.value },
        recordedAt: now,
      })
      const enqueue = yield* jobs.enqueueFromDelivery({
        jobId: ids.kernelJobId,
        instanceId: ids.instanceId,
        waitId: ids.waitId,
        eventSequence: recorded.event.sequence,
        expectedCursor: wait.wait.afterSequence,
        inputVersion: 1,
        input: { kind: "echo", value: decoded.value },
        maxAttempts: 3,
        runAt: recorded.event.recordedAt,
        createdAt: recorded.event.recordedAt,
      })
      const current = yield* status(decoded.jobId)
      return {
        ...current,
        newlyEnqueued: enqueue.status === "enqueued",
      }
    }).pipe(
      sql.withTransaction,
      Effect.mapError((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error._tag === "KernelStoreConflictError" || error._tag === "KernelJobStoreConflictError")
          ? new TestJobCanaryConflict({ jobId: input.jobId })
          : error,
      ),
    )

  return TestJobCanary.of({ submit, status })
})

export const TestJobCanaryLive = Layer.effect(TestJobCanary, make)

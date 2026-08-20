import { Schema } from "effect"
import type { EventCondition } from "./event-store"

const Identifier = Schema.NonEmptyString.pipe(Schema.maxLength(256))
const Instant = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/))

export const JOB_COMPLETED_TYPE = "job.completed"
export const JOB_COMPLETED_VERSION = 1
export const WAIT_FOR_JOB_WORKFLOW_TYPE = "wait_for_job"
export const WAIT_FOR_JOB_WORKFLOW_VERSION = 1

export const JobCompletedEventV1 = Schema.Union(
  Schema.Struct({
    jobId: Identifier,
    outcome: Schema.Literal("succeeded"),
    resultId: Identifier,
    resultVersion: Schema.Int.pipe(Schema.positive()),
    completedAt: Instant,
  }),
  Schema.Struct({
    jobId: Identifier,
    outcome: Schema.Literal("failed", "operator_required"),
    failureCategory: Schema.Literal("transient", "permanent", "operator_required"),
    failureVersion: Schema.Int.pipe(Schema.positive()),
    completedAt: Instant,
  }),
)
export type JobCompletedEventV1 = typeof JobCompletedEventV1.Type

export const WaitForJobWorkflowV1 = Schema.Struct({
  kind: Schema.Literal(WAIT_FOR_JOB_WORKFLOW_TYPE),
  jobId: Identifier,
  provider: Schema.Literal("opencode"),
  sessionId: Identifier,
  host: Identifier,
})
export type WaitForJobWorkflowV1 = typeof WaitForJobWorkflowV1.Type

export const jobCompletionCondition = (jobId: string): EventCondition => ({
  type: JOB_COMPLETED_TYPE,
  version: JOB_COMPLETED_VERSION,
  key: jobId,
  correlation: jobId,
})

export const jobCompletionEvent = (payload: JobCompletedEventV1) => ({
  source: "kernel-job",
  sourceEventId: `job-completed:${payload.jobId}`,
  event: { ...jobCompletionCondition(payload.jobId), payload },
  recordedAt: new Date(payload.completedAt),
})

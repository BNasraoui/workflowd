import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { JsonValueSchema } from "../json"
import { JobCompletedEventV1, WaitForJobWorkflowV1 } from "./job-completion-contract"
import { KernelJobStore } from "./job-store"

const CandidateRow = Schema.Struct({
  instance_id: Schema.String,
  wait_id: Schema.String,
  event_sequence: Schema.Int.pipe(Schema.positive()),
  event_cursor: Schema.Int.pipe(Schema.nonNegative()),
  payload_json: Schema.parseJson(WaitForJobWorkflowV1),
  event_payload_json: Schema.parseJson(JobCompletedEventV1),
  job_state: Schema.Literal("succeeded", "failed", "operator_required"),
  result_id: Schema.NullOr(Schema.String),
  result_version: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  result_json: Schema.NullOr(Schema.parseJson(JsonValueSchema)),
  failure_category: Schema.NullOr(Schema.Literal("transient", "permanent", "operator_required")),
  failure_version: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  failure_json: Schema.NullOr(Schema.parseJson(JsonValueSchema)),
})

export const enqueueNextJobCompletionResume = (now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const jobs = yield* KernelJobStore
    const candidates = yield* sql`SELECT
        instance.instance_id, delivery.wait_id, delivery.event_sequence,
        instance.event_cursor, instance.payload_json, event.payload_json AS event_payload_json,
        job.state AS job_state, result.result_id, result.result_version, result.result_json,
        job.failure_category, job.failure_version, job.failure_json
      FROM kernel_wait_event_deliveries AS delivery
      JOIN kernel_workflow_instances AS instance ON instance.instance_id = delivery.instance_id
      JOIN kernel_events AS event ON event.sequence = delivery.event_sequence
      JOIN kernel_workflow_jobs AS job
        ON job.job_id = json_extract(instance.payload_json, '$.jobId')
      LEFT JOIN kernel_workflow_job_results AS result ON result.job_id = job.job_id
      JOIN kernel_sessions AS session
        ON session.session_id = json_extract(instance.payload_json, '$.sessionId')
        AND session.provider_kind = json_extract(instance.payload_json, '$.provider')
        AND session.owning_host_id = json_extract(instance.payload_json, '$.host')
      WHERE instance.workflow_type = 'wait_for_job' AND instance.workflow_version = 1
        AND delivery.state = 'ready'
      ORDER BY delivery.event_sequence, instance.instance_id`
    for (const candidate of candidates) {
      const decoded = yield* Schema.decodeUnknown(CandidateRow)(candidate, {
        onExcessProperty: "error",
      }).pipe(Effect.either)
      if (decoded._tag === "Left") continue
      const row = decoded.right
      const workflow = row.payload_json
      const completion = row.event_payload_json
      if (workflow.jobId !== completion.jobId) continue
      const prompt =
        completion.outcome === "succeeded"
          ? row.job_state === "succeeded" &&
            row.result_id === completion.resultId &&
            row.result_version === completion.resultVersion &&
            row.result_json !== null
            ? { kind: "workflowd.job.completed" as const, ...completion, result: row.result_json }
            : null
          : row.job_state === completion.outcome &&
              row.failure_category === completion.failureCategory &&
              row.failure_version === completion.failureVersion &&
              row.failure_json !== null
            ? {
                kind: "workflowd.job.completed" as const,
                ...completion,
                failure: {
                  category: row.failure_category,
                  version: row.failure_version,
                  payload: row.failure_json,
                },
              }
            : null
      if (prompt === null) continue
      const jobId = `${row.instance_id}:resume-session`
      const result = yield* jobs.enqueueFromDelivery({
        jobId,
        instanceId: row.instance_id,
        waitId: row.wait_id,
        eventSequence: row.event_sequence,
        expectedCursor: row.event_cursor,
        inputVersion: 1,
        input: {
          kind: "resume_parent_agent",
          parentSessionId: workflow.sessionId,
          resumePrompt: prompt,
          resumePromptText: JSON.stringify(prompt),
          outputContract: "workflowd.job.completed",
          outputContractVersion: 1,
          registeredAt: now.toISOString(),
        },
        maxAttempts: 3,
        runAt: now,
        createdAt: now,
      })
      return { status: result.status, jobId }
    }
    return { status: "idle" as const }
  })

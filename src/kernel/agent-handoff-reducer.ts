import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { AgentSessionCompletedEventV1, WaitForAgentWorkflowV1 } from "./agent-handoff-contract"
import { KernelJobStore } from "./job-store"

const CandidateRow = Schema.Struct({
  instance_id: Schema.String,
  wait_id: Schema.String,
  event_sequence: Schema.Int.pipe(Schema.positive()),
  event_cursor: Schema.Int.pipe(Schema.nonNegative()),
  payload_json: Schema.parseJson(WaitForAgentWorkflowV1),
  event_payload_json: Schema.parseJson(AgentSessionCompletedEventV1),
})

const matches = (row: typeof CandidateRow.Type) =>
  row.payload_json.childSessionId === row.event_payload_json.childSessionId &&
  row.payload_json.childSessionGeneration === row.event_payload_json.childSessionGeneration

export const enqueueNextAgentHandoff = (now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const jobs = yield* KernelJobStore
    const candidates = yield* sql`SELECT
        instance.instance_id, delivery.wait_id, delivery.event_sequence,
        instance.event_cursor, instance.payload_json, event.payload_json AS event_payload_json
      FROM kernel_wait_event_deliveries AS delivery
      JOIN kernel_workflow_instances AS instance ON instance.instance_id = delivery.instance_id
      JOIN kernel_events AS event ON event.sequence = delivery.event_sequence
      WHERE instance.workflow_type = 'wait_for_agent' AND instance.workflow_version = 1
        AND delivery.state = 'ready'
      ORDER BY delivery.event_sequence, instance.instance_id`
    for (const candidate of candidates) {
      const decoded = yield* Schema.decodeUnknown(CandidateRow)(candidate, {
        onExcessProperty: "error",
      }).pipe(Effect.either)
      if (decoded._tag === "Left" || !matches(decoded.right)) {
        const instanceId = typeof candidate.instance_id === "string" ? candidate.instance_id : ""
        if (instanceId.length > 0) {
          yield* sql`UPDATE kernel_agent_completion_watches SET state = 'data_error',
            updated_at = ${now.toISOString()} WHERE instance_id = ${instanceId}
              AND state IN ('watching', 'completed')`
        }
        continue
      }
      const row = decoded.right
      const workflow = row.payload_json
      const jobId = `${row.instance_id}:resume-parent`
      const result = yield* jobs.enqueueFromDelivery({
        jobId,
        instanceId: row.instance_id,
        waitId: row.wait_id,
        eventSequence: row.event_sequence,
        expectedCursor: row.event_cursor,
        inputVersion: 1,
        input: {
          kind: "resume_parent_agent",
          parentSessionId: workflow.parentSessionId,
          resumePrompt: workflow.resumePrompt,
          resumePromptText: workflow.resumePromptText,
          outputContract: workflow.outputContract,
          outputContractVersion: workflow.outputContractVersion,
          registeredAt: now.toISOString(),
        },
        maxAttempts: workflow.retryPolicy.maxAttempts,
        runAt: now,
        createdAt: now,
      })
      return { status: result.status, jobId }
    }
    return { status: "idle" as const }
  })

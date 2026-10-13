import { createHash } from "node:crypto"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Schema } from "effect"
import { MAX_CLAUDE_RESUME_PROMPT_BYTES } from "../remote/contract"
import { AgentSessionCompletedEventV1, WaitForAgentWorkflowV1 } from "./agent-handoff-contract"
import { recordAgentWakeFailure } from "./agent-wake-failure"
import { KernelSessionStore } from "./session-store"
import { KernelJobStore } from "./job-store"
import { canonicalJson } from "./session-store-support"

const CandidateRow = Schema.Struct({
  instance_id: Schema.String,
  wait_id: Schema.String,
  event_sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  event_cursor: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  payload_json: Schema.fromJsonString(WaitForAgentWorkflowV1),
  event_payload_json: Schema.fromJsonString(AgentSessionCompletedEventV1),
})

const TerminalMessage = Schema.Struct({
  run_id: Schema.String,
  native_session_id: Schema.NullOr(Schema.String),
  status: Schema.String,
  end_reason: Schema.String,
  final_message: Schema.NullOr(Schema.String),
  final_message_ref: Schema.NullOr(Schema.String),
})

const matches = (row: typeof CandidateRow.Type) =>
  row.payload_json.childSessionId === row.event_payload_json.childSessionId &&
  row.payload_json.childSessionGeneration === row.event_payload_json.childSessionGeneration

export const enqueueNextAgentHandoff = (now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* Effect.gen(function* () {
      const jobs = yield* KernelJobStore
      const sessions = yield* KernelSessionStore
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
        const decoded = yield* Schema.decodeUnknownEffect(CandidateRow)(candidate, {
          onExcessProperty: "error",
        }).pipe(Effect.result)
        if (decoded._tag === "Failure" || !matches(decoded.success)) {
          const instanceId = typeof candidate.instance_id === "string" ? candidate.instance_id : ""
          if (instanceId.length > 0) {
            yield* sql`UPDATE kernel_agent_completion_watches SET state = 'data_error',
            updated_at = ${now.toISOString()} WHERE instance_id = ${instanceId}
              AND state IN ('watching', 'completed')`
          }
          continue
        }
        const row = decoded.success
        const workflow = row.payload_json
        const parents = yield* sql<{ owning_host_id: string }>`SELECT session.owning_host_id
        FROM kernel_sessions AS session
        JOIN kernel_working_resources AS resource ON resource.resource_id = session.resource_id
        WHERE session.session_id = ${workflow.parentSessionId}
          AND session.state IN ('ready', 'active') AND resource.state = 'reserved'
          AND NOT EXISTS (SELECT 1 FROM kernel_cleanup_requests AS cleanup
            WHERE cleanup.resource_id = session.resource_id
              AND cleanup.state IN ('pending', 'leased', 'retry_scheduled', 'operator_required'))`
        if (parents[0] === undefined) {
          yield* recordAgentWakeFailure({
            parentSessionId: workflow.parentSessionId,
            identity: row.instance_id,
            reason: "parent_custody_unavailable",
            now,
          })
          continue
        }
        const mailboxRows = yield* sql<{
          readonly mailbox_id: string
          readonly prompt: string
        }>`SELECT run.caller_mailbox_id AS mailbox_id, inbox.prompt
        FROM kernel_agent_runs AS run
        JOIN resident_inbox AS inbox ON inbox.id = 'agent-run-end-' || run.run_id
        WHERE run.session_id = ${workflow.childSessionId}
        LIMIT 1`
        let resumePrompt = workflow.resumePrompt
        let resumePromptText = workflow.resumePromptText
        if (mailboxRows[0] !== undefined) {
          const terminal = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(TerminalMessage),
          )(mailboxRows[0].prompt)
          const task = yield* Schema.decodeUnknownEffect(Schema.Struct({ task: Schema.String }))(
            workflow.resumePrompt,
          )
          const result = {
            run_id: terminal.run_id,
            mailbox_id: mailboxRows[0].mailbox_id,
            status: terminal.status,
            end_reason: terminal.end_reason,
            final_message: terminal.final_message,
            final_message_ref: terminal.final_message_ref,
          }
          let prompt = { task: task.task, terminal: result }
          if (
            new TextEncoder().encode(canonicalJson(prompt)).byteLength >
            MAX_CLAUDE_RESUME_PROMPT_BYTES
          ) {
            prompt = {
              task: task.task,
              terminal: {
                ...result,
                final_message: null,
                final_message_ref: terminal.native_session_id,
              },
            }
          }
          resumePrompt = prompt
          resumePromptText = canonicalJson(prompt)
        }
        const jobId = `${row.instance_id}:resume-parent`
        // A consumed wait always has its resume request, even if custody changes
        // before the job runner acknowledges this handoff.
        yield* sessions.registerResumeRequest({
          requestId: `${jobId}:request`,
          sessionId: workflow.parentSessionId,
          owningHostId: parents[0].owning_host_id,
          prompt: resumePrompt,
          promptText: resumePromptText,
          promptSha256: createHash("sha256").update(resumePromptText).digest("hex"),
          outputContract: workflow.outputContract,
          outputContractVersion: workflow.outputContractVersion,
          maxAttempts: workflow.retryPolicy.maxAttempts,
          runAt: now,
          createdAt: now,
        })
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
            resumePrompt,
            resumePromptText,
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
    }).pipe(sql.withTransaction)
  })

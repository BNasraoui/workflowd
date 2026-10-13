import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { canonicalJson } from "./session-store-support"

export const agentWakeMailboxId = (parentSessionId: string) =>
  `agent-wake-mailbox-${parentSessionId}`

/** Durable, prompt-free notice for both standalone waits and dispatch callers.
 * Call inside the transaction that records the failed delivery. */
export const recordAgentWakeFailure = (input: {
  readonly parentSessionId: string
  readonly identity: string
  readonly reason: string
  readonly failureReason?: string
  readonly now: Date
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const linked = yield* sql<{ caller_mailbox_id: string }>`SELECT DISTINCT run.caller_mailbox_id
      FROM kernel_workflow_instances AS instance
      JOIN kernel_agent_runs AS run ON run.session_id = json_extract(instance.payload_json, '$.childSessionId')
      WHERE instance.workflow_type = 'wait_for_agent'
        AND (instance.instance_id = ${input.identity}
          OR instance.instance_id || ':resume-parent:request' = ${input.identity}
          OR instance.instance_id || ':resume-parent' = ${input.identity})`
    const mailboxes = new Set([
      agentWakeMailboxId(input.parentSessionId),
      ...linked.map((row) => row.caller_mailbox_id),
    ])
    const message = canonicalJson({
      kind: "agent_wake_failed",
      parent_session_id: input.parentSessionId,
      wake_id: input.identity,
      reason: input.reason,
      failure_reason: input.failureReason ?? null,
      observed_at: input.now.toISOString(),
    })
    for (const mailbox of mailboxes) {
      yield* sql`INSERT INTO resident_inbox (id, thread_id, mailbox_id, prompt, state)
        VALUES (${`agent-wake-failed:${input.identity}:${mailbox}`}, NULL, ${mailbox}, ${message}, 'delivered')
        ON CONFLICT (id) DO NOTHING`
    }
  })

import { createHash } from "node:crypto"
import { Config, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { CiTarget } from "../ci/event"
import { CiService } from "../ci/service"
import { AgentRunStore } from "../kernel/agent-run-store"
import { KernelEventStore } from "../kernel/event-store"
import { makeResidentStore } from "./store"

export const EventSelector = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ci"), ...CiTarget.fields }),
  Schema.Struct({ kind: Schema.Literal("agent_run"), run_id: Schema.NonEmptyString }),
])
export type EventSelector = typeof EventSelector.Type
const Subscription = Schema.Struct({ threadId: Schema.String, selector: EventSelector })
const Pending = Schema.Struct({
  instance_id: Schema.String,
  event_cursor: Schema.Number,
  payload_json: Schema.fromJsonString(Subscription),
})

/** Mailbox delivery is a reducer of the same durable waits used by parent wakes. */
export const makeSubscriptions = Effect.gen(function* () {
  const waitTimeoutMs = yield* Config.int("WORKFLOWD_CI_WAIT_TIMEOUT_MS").pipe(
    Config.withDefault(86_400_000),
  )
  if (waitTimeoutMs <= 0)
    return yield* Effect.fail(new Error("WORKFLOWD_CI_WAIT_TIMEOUT_MS must be positive"))
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore
  const inbox = yield* makeResidentStore
  const ci = yield* CiService
  const runs = yield* AgentRunStore
  const resultFor = Effect.fn("Subscriptions.result")(function* (
    threadId: string,
    selector: EventSelector,
  ) {
    const thread = yield* inbox.read(threadId)
    const expired =
      selector.kind === "ci" &&
      thread?.wait_deadline !== null &&
      thread?.wait_deadline !== undefined &&
      thread.wait_deadline <= Date.now()
    let result: Record<string, string | number | null | readonly string[]> | null = null
    if (expired)
      result = {
        kind: "ci",
        status: "operator_required",
        diagnostic: "CI result did not arrive in time",
      }
    else if (selector.kind === "ci") {
      const state = yield* ci.read(selector)
      if (state !== null && state.conclusion !== "pending")
        result = { ...state, runLinks: state.runLinks ?? [] }
    }
    if (selector.kind === "agent_run") {
      const run = yield* runs.read(selector.run_id)
      if (
        run !== null &&
        ["completed", "failed", "cancelled", "operator_required"].includes(run.state)
      )
        result = {
          kind: "agent_run",
          runId: run.runId,
          status: run.state,
          summaryPointer: run.nativeSessionId ?? run.runId,
          diagnostic: run.diagnostic,
        }
    }
    return { result, expired }
  })
  const reconcile = Effect.fn("Subscriptions.reconcile")(function* () {
    yield* sql`UPDATE resident_threads SET wait_deadline = (
      SELECT MIN(CAST(unixepoch(i.created_at) * 1000 AS INTEGER)) + ${waitTimeoutMs}
      FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id = i.instance_id
      WHERE i.workflow_type = 'mailbox_subscription' AND i.workflow_key = resident_threads.thread_id
        AND json_extract(i.payload_json, '$.selector.kind') = 'ci' AND w.state IN ('pending','matched')
    ) WHERE wait_deadline IS NULL AND state IN ('active','waiting')`
    const rows = yield* sql`SELECT i.instance_id, i.event_cursor, i.payload_json
      FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id = i.instance_id
      WHERE i.workflow_type = 'mailbox_subscription' AND w.state IN ('pending','matched')`
    for (const raw of rows) {
      const row = yield* Schema.decodeUnknownEffect(Pending)(raw)
      const { threadId, selector } = row.payload_json
      const { result, expired } = yield* resultFor(threadId, selector)
      if (result === null) continue
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const id = row.instance_id
          const current =
            yield* sql`SELECT state FROM kernel_waits WHERE instance_id = ${id} AND wait_id = ${id}`
          if (current[0]?.state !== "pending" && current[0]?.state !== "matched") return
          yield* events.recordEvent({
            source: "mailbox_subscription",
            sourceEventId: id,
            event: {
              type: "mailbox.result",
              version: 1,
              key: id,
              correlation: id,
              payload: result,
            },
            recordedAt: new Date(),
          })
          const deliveries = yield* events.readReadyDeliveries(id)
          for (const delivery of deliveries) {
            yield* inbox.enqueue(
              id,
              threadId,
              expired
                ? "workflowd: CI result did not arrive in time. Operator attention is required; late results will not resume this subscription."
                : `workflowd completion: ${JSON.stringify(delivery.event.payload)}. Continue the task from this result.`,
            )
            const thread = yield* inbox.read(threadId)
            if (
              expired ||
              thread === null ||
              thread.state === "finished" ||
              thread.state === "operator_required"
            )
              yield* inbox.uncertain(id, threadId)
            if (expired && thread !== null) {
              const run = yield* runs.read(thread.run_id)
              if (run?.state === "verified")
                yield* runs.operatorRequired({
                  runId: thread.run_id,
                  diagnostic: "ci_wait_deadline: CI result did not arrive in time",
                  now: new Date(),
                })
            }
            yield* events.consumeDelivery({
              instanceId: id,
              waitId: id,
              eventSequence: delivery.eventSequence,
              expectedCursor: row.event_cursor,
            })
          }
          yield* sql`UPDATE resident_threads SET wait_deadline = NULL WHERE thread_id = ${threadId}
            AND NOT EXISTS (SELECT 1 FROM kernel_waits w JOIN kernel_workflow_instances i ON i.instance_id = w.instance_id
              WHERE i.workflow_type = 'mailbox_subscription' AND i.workflow_key = ${threadId}
              AND json_extract(i.payload_json, '$.selector.kind') = 'ci' AND w.state IN ('pending','matched'))`
        }),
      )
    }
  })
  const register = Effect.fn("Subscriptions.register")(function* (
    threadId: string,
    input: EventSelector,
  ) {
    const selector =
      input.kind === "ci"
        ? {
            kind: input.kind,
            repository: input.repository.toLowerCase(),
            sha: input.sha.toLowerCase(),
          }
        : { kind: input.kind, run_id: input.run_id }
    const payload = { threadId, selector }
    const id = `subscription-${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`
    const status = yield* sql.withTransaction(
      Effect.gen(function* () {
        const instance = yield* events.createInstance({
          instanceId: id,
          workflowType: "mailbox_subscription",
          workflowVersion: 1,
          workflowKey: threadId,
          payload,
          createdAt: new Date(),
        })
        if (instance.status === "created") {
          yield* inbox.park(threadId)
          if (selector.kind === "ci")
            yield* sql`UPDATE resident_threads SET wait_deadline = COALESCE(wait_deadline, ${Date.now() + waitTimeoutMs}) WHERE thread_id = ${threadId}`
          yield* events.registerWait({
            instanceId: id,
            waitId: id,
            condition: { type: "mailbox.result", version: 1, key: id, correlation: id },
            registeredAt: new Date(),
          })
        }
        return instance.status === "created" ? "registered" : "duplicate"
      }),
    )
    yield* reconcile()
    return { id, status }
  })
  return { register, reconcile }
})

import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
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
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore
  const inbox = yield* makeResidentStore
  const ci = yield* CiService
  const runs = yield* AgentRunStore
  const reconcile = Effect.fn("Subscriptions.reconcile")(function* () {
    const rows = yield* sql`SELECT i.instance_id, i.event_cursor, i.payload_json
      FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id = i.instance_id
      WHERE i.workflow_type = 'mailbox_subscription' AND w.state IN ('pending','matched')`
    for (const raw of rows) {
      const row = yield* Schema.decodeUnknownEffect(Pending)(raw)
      const { threadId, selector } = row.payload_json
      let result: Record<string, string | number | null | readonly string[]> | null = null
      if (selector.kind === "ci") {
        const state = yield* ci.read(selector)
        if (state !== null && state.conclusion !== "pending")
          result = { ...state, runLinks: state.runLinks ?? [] }
      }
      if (selector.kind === "agent_run") {
        const run = yield* runs.read(selector.run_id)
        if (run !== null && ["completed", "failed", "operator_required"].includes(run.state))
          result = {
            kind: "agent_run",
            runId: run.runId,
            status: run.state,
            summaryPointer: run.nativeSessionId ?? run.runId,
            diagnostic: run.diagnostic,
          }
      }
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
              `workflowd completion: ${JSON.stringify(delivery.event.payload)}. Continue the task from this result.`,
            )
            const thread = yield* inbox.read(threadId)
            if (
              thread === null ||
              thread.state === "finished" ||
              thread.state === "operator_required"
            )
              yield* inbox.uncertain(id, threadId)
            yield* events.consumeDelivery({
              instanceId: id,
              waitId: id,
              eventSequence: delivery.eventSequence,
              expectedCursor: row.event_cursor,
            })
          }
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
        : input
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

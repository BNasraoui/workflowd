import { createHash } from "node:crypto"
import { Config, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { CiTarget } from "../ci/event"
import { CiService } from "../ci/service"
import { JsonValueSchema, type JsonValue } from "../json"
import { AgentRunStore } from "../kernel/agent-run-store"
import { KernelEventStore } from "../kernel/event-store"
import { MAX_KERNEL_PAYLOAD_BYTES } from "../kernel/event-store-model"
import { canonicalJson } from "../kernel/session-store-support"
import { makeResidentStore } from "./store"

export const EventSelector = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ci"), ...CiTarget.fields }),
  Schema.Struct({ kind: Schema.Literal("agent_run"), run_id: Schema.NonEmptyString }),
])
export type EventSelector = typeof EventSelector.Type
const Subscription = Schema.Struct({
  threadId: Schema.String,
  selector: EventSelector,
  deadline: Schema.optionalKey(Schema.Number),
})
const TerminalMessage = Schema.fromJsonString(Schema.Record(Schema.String, JsonValueSchema))
const Pending = Schema.Struct({
  instance_id: Schema.String,
  event_cursor: Schema.Number,
  created_at: Schema.String,
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
  /**
   * The child's caller-mailbox message, written with its terminal state in one
   * transaction. A final message too large for one kernel event is replaced by
   * its session reference, as the mailbox does when a run ends without one.
   */
  const terminalFor = Effect.fn("Subscriptions.terminal")(function* (
    runId: string,
    summary: Record<string, JsonValue>,
  ) {
    const rows = yield* sql<{ prompt: string }>`SELECT prompt FROM resident_inbox
      WHERE id = ${"agent-run-end-" + runId} AND thread_id IS NULL`
    if (rows[0] === undefined) return null
    const terminal = yield* Schema.decodeUnknownEffect(TerminalMessage)(rows[0].prompt)
    const size = new TextEncoder().encode(canonicalJson({ ...summary, terminal })).byteLength
    return size <= MAX_KERNEL_PAYLOAD_BYTES
      ? terminal
      : {
          ...terminal,
          final_message: null,
          final_message_ref: terminal.native_session_id ?? runId,
        }
  })
  const resultFor = Effect.fn("Subscriptions.result")(function* (
    selector: EventSelector,
    deadline: number | undefined,
    createdAt: string,
  ) {
    let diagnostic: string | null = null
    let result: Record<string, JsonValue> | null = null
    if (selector.kind === "ci") {
      const state = yield* ci.read(selector)
      if (state !== null && state.conclusion !== "pending")
        result = { ...state, runLinks: state.runLinks ?? [] }
      else if (deadline !== undefined && deadline <= Date.now()) {
        diagnostic = "ci_wait_deadline: CI result did not arrive in time"
      } else if (
        Date.now() - Date.parse(createdAt) >= 10 * 60_000 &&
        (state?.runLinks?.length ?? 0) === 0
      ) {
        diagnostic = "ci_wait_no_required_run: No required workflow run observed within 10 minutes"
      }
      if (diagnostic !== null) result = { ...selector, status: "operator_required", diagnostic }
    }
    if (selector.kind === "agent_run") {
      const run = yield* runs.read(selector.run_id)
      if (
        run !== null &&
        ["completed", "failed", "cancelled", "operator_required"].includes(run.state)
      ) {
        const summary = {
          kind: "agent_run",
          runId: run.runId,
          status: run.state,
          summaryPointer: run.nativeSessionId ?? run.runId,
          diagnostic: run.diagnostic,
        }
        result = { ...summary, terminal: yield* terminalFor(run.runId, summary) }
      }
    }
    return { result, diagnostic }
  })
  const reconcile = Effect.fn("Subscriptions.reconcile")(function* () {
    // Older subscriptions have no payload deadline. Anchor them to their own creation time.
    yield* sql`UPDATE kernel_workflow_instances SET payload_json = json_set(payload_json,
      '$.deadline', CAST(unixepoch(created_at, 'subsec') * 1000 AS INTEGER) + ${waitTimeoutMs})
      WHERE workflow_type = 'mailbox_subscription'
        AND json_extract(payload_json, '$.selector.kind') = 'ci'
        AND json_extract(payload_json, '$.deadline') IS NULL`
    const rows = yield* sql`SELECT i.instance_id, i.event_cursor, i.created_at, i.payload_json
      FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id = i.instance_id
      WHERE i.workflow_type = 'mailbox_subscription' AND w.state IN ('pending','matched')`
    for (const raw of rows) {
      const row = yield* Schema.decodeUnknownEffect(Pending)(raw)
      const { threadId, selector, deadline } = row.payload_json
      const { result, diagnostic } = yield* resultFor(selector, deadline, row.created_at)
      const expired = diagnostic !== null
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
                ? `workflowd: ${diagnostic} (${selector.kind === "ci" ? `${selector.repository}@${selector.sha}` : ""}). Operator attention is required; late results will not resume this subscription.`
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
                  diagnostic,
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
        }),
      )
    }
    yield* sql`UPDATE resident_threads SET wait_deadline = (
      SELECT MIN(json_extract(i.payload_json, '$.deadline'))
      FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id = i.instance_id
      WHERE i.workflow_type = 'mailbox_subscription' AND i.workflow_key = resident_threads.thread_id
        AND json_extract(i.payload_json, '$.selector.kind') = 'ci' AND w.state IN ('pending','matched')
    )`
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
        const existing =
          yield* sql`SELECT payload_json FROM kernel_workflow_instances WHERE instance_id = ${id}`
        const durablePayload =
          existing.length > 0
            ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Subscription))(
                existing[0]?.payload_json,
              )
            : {
                ...payload,
                ...(selector.kind === "ci" ? { deadline: Date.now() + waitTimeoutMs } : {}),
              }
        const instance = yield* events.createInstance({
          instanceId: id,
          workflowType: "mailbox_subscription",
          workflowVersion: 1,
          workflowKey: threadId,
          payload: durablePayload,
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

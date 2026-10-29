import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TypedEventEnvelope, type EventCondition } from "../kernel/event-store-model"
import { KernelEventStore, KernelStoreConflictError } from "../kernel/event-store"
import { AgentDirectory } from "../directory/service"
import { canonicalJson } from "../kernel/session-store-support"
import { makeMessageStore } from "./store"
import { MessagingError, messagingError, SubscribeEvent, PublishEvent } from "./contract"

// Public producers cannot forge existing custody/completion events. Both sides
// normalize the application condition into this module's kernel namespace.
const kernelCondition = (condition: EventCondition) => ({
  type: "agent_message.event",
  version: 1,
  key: createHash("sha256").update(canonicalJson(condition)).digest("hex"),
  correlation: condition.correlation,
})
const instanceId = (id: string) => `message-subscription:${id}`
const Row = Schema.Struct({
  instance_id: Schema.String,
  payload_json: Schema.fromJsonString(SubscribeEvent),
  event_cursor: Schema.Number,
  state: Schema.Literals(["pending", "matched", "consumed", "cancelled"]),
})
export const makeMessageSubscriptions = (
  hostId: string,
  directory: typeof AgentDirectory.Service,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const events = yield* KernelEventStore
    const messages = yield* makeMessageStore
    const read = Effect.fn("Messaging.subscription")(
      function* (id: string) {
        const rows =
          yield* sql`SELECT i.instance_id,i.payload_json,i.event_cursor,w.state FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id=i.instance_id AND w.wait_id=i.instance_id WHERE i.instance_id=${instanceId(id)} AND i.workflow_type='agent_message_subscription'`
        if (rows.length === 0)
          return yield* Effect.fail(new MessagingError({ reason: "not_found" }))
        const row = yield* Schema.decodeUnknownEffect(Row)(rows[0])
        return { ...row.payload_json, state: row.state }
      },
      (effect) => effect.pipe(Effect.mapError(messagingError)),
    )
    const register = Effect.fn("Messaging.subscribe")(
      function* (input: SubscribeEvent) {
        const snapshot = yield* directory.inventory()
        if (!snapshot.agents.some((agent) => agent.recipientId === input.recipient))
          return yield* Effect.fail(new MessagingError({ reason: "unavailable" }))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const id = instanceId(input.id)
            const instance = yield* events.createInstance({
              instanceId: id,
              workflowType: "agent_message_subscription",
              workflowVersion: 1,
              workflowKey: input.recipient,
              payload: input,
              createdAt: new Date(),
            })
            yield* events.registerWait({
              instanceId: id,
              waitId: id,
              condition: kernelCondition(input.condition),
              registeredAt: new Date(),
            })
            const current = yield* read(input.id)
            return {
              id: input.id,
              status:
                instance.status === "created" ? ("registered" as const) : ("duplicate" as const),
              state: current.state,
            }
          }),
        )
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((error) =>
            error instanceof KernelStoreConflictError
              ? new MessagingError({ reason: "conflict" })
              : messagingError(error),
          ),
        ),
    )
    const cancel = Effect.fn("Messaging.cancelSubscription")(
      function* (id: string) {
        yield* read(id)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE kernel_waits SET state='cancelled' WHERE instance_id=${instanceId(id)} AND state IN ('pending','matched')`
            yield* sql`UPDATE kernel_wait_event_deliveries SET state='cancelled' WHERE instance_id=${instanceId(id)} AND state='ready'`
          }),
        )
        return yield* read(id)
      },
      (effect) => effect.pipe(Effect.mapError(messagingError)),
    )
    const publish = Effect.fn("Messaging.publishEvent")(
      function* (input: typeof PublishEvent.Type) {
        if (Buffer.byteLength(canonicalJson(input)) > 6000)
          return yield* Effect.fail(new MessagingError({ reason: "invalid" }))
        const result = yield* events.recordEvent({
          source: `host:${hostId}`,
          sourceEventId: input.id,
          event: {
            ...kernelCondition({
              type: input.event.type,
              version: input.event.version,
              key: input.event.key,
              correlation: input.event.correlation,
            }),
            payload: input.event,
          },
          recordedAt: new Date(),
        })
        return { id: input.id, status: result.status }
      },
      (effect) =>
        effect.pipe(
          Effect.mapError((error) =>
            error instanceof KernelStoreConflictError
              ? new MessagingError({ reason: "conflict" })
              : messagingError(error),
          ),
        ),
    )
    const reconcile = Effect.fn("Messaging.routeEvents")(
      function* () {
        const rows =
          yield* sql`SELECT i.instance_id,i.payload_json,i.event_cursor,w.state FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id=i.instance_id AND w.wait_id=i.instance_id WHERE i.workflow_type='agent_message_subscription' AND w.state='matched' LIMIT 100`
        if (rows.length === 0) return
        const snapshot = yield* directory.inventory()
        for (const raw of rows) {
          const row = yield* Schema.decodeUnknownEffect(Row)(raw)
          const target = snapshot.agents.find(
            (agent) => agent.recipientId === row.payload_json.recipient,
          )
          if (target === undefined || !target.deliverable) continue
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const delivery of yield* events.readReadyDeliveries(row.instance_id)) {
                const hex = createHash("sha256")
                  .update(`${row.instance_id}:${delivery.eventSequence}`)
                  .digest("hex")
                const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
                const applicationEvent = yield* Schema.decodeUnknownEffect(TypedEventEnvelope)(
                  delivery.event.payload,
                )
                yield* messages.accept(
                  {
                    id,
                    sender: `host:${hostId}`,
                    recipient: target.recipientId,
                    correlation: delivery.event.correlation,
                    replyTo: null,
                    payload: {
                      type: applicationEvent.type,
                      version: applicationEvent.version,
                      data: applicationEvent.payload,
                    },
                  },
                  target,
                  hostId,
                )
                yield* events.consumeDelivery({
                  instanceId: row.instance_id,
                  waitId: row.instance_id,
                  eventSequence: delivery.eventSequence,
                  expectedCursor: row.event_cursor,
                })
              }
            }),
          )
        }
      },
      (effect) => effect.pipe(Effect.mapError(messagingError)),
    )
    return { register, read, cancel, publish, reconcile }
  })

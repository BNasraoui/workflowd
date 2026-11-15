import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DirectoryStore } from "../directory/store"
import { canonicalJson } from "../kernel/session-store-support"
import { makeResidentStore } from "../resident/store"
import { externalRecipientId } from "../directory/proof"
import { makeMessageStore } from "./store"
import { deliverRelay } from "./relay"
import { messagingError, type MessageRecord } from "./contract"

export const sameBinding = (left: MessageRecord["target"], right: MessageRecord["target"]) =>
  left.recipientId === right.recipientId &&
  left.hostId === right.hostId &&
  left.bindingVersion === right.bindingVersion &&
  canonicalJson(left.endpoint) === canonicalJson(right.endpoint)

export const makeMessageDelivery = (hostId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const directory = yield* DirectoryStore
    const messages = yield* makeMessageStore
    const inbox = yield* makeResidentStore
    const refuseUnsent = Effect.fn("Messaging.refuseUnsent")(
      function* (id: string, refusal: "stale_binding" | "unsupported") {
        const inboxId = `message:${id}`
        // Fence prepared input before sampling native facts. This write serializes
        // with sending(), so a native claim either wins or cannot start afterwards.
        const fenced =
          yield* sql`UPDATE resident_inbox SET state='operator_required' WHERE id=${inboxId} AND state='prepared' RETURNING id`
        const native = yield* inbox.deliveryState(inboxId)
        const current = yield* messages.read(id)
        const uncertain =
          native === "sending" ||
          (native === "operator_required" && fenced.length === 0) ||
          current?.relayIntent ||
          current?.delivery === "uncertain"
        yield* messages.update(
          id,
          native === "delivered" ? "delivered" : uncertain ? "uncertain" : refusal,
        )
      },
      (effect) => effect.pipe(sql.withTransaction),
    )
    const deliver = Effect.fn("Messaging.deliver")(
      function* (record: MessageRecord) {
        if (!["pending", "queued", "uncertain"].includes(record.delivery)) return
        if (record.target.hostId !== hostId) return
        const inboxId = `message:${record.message.id}`
        if (record.delivery === "queued" || record.delivery === "uncertain") {
          const nativeState = yield* inbox.deliveryState(inboxId)
          if (nativeState === "delivered") {
            yield* messages.update(record.message.id, "delivered")
            return
          }
          if (nativeState === "operator_required") {
            yield* messages.update(record.message.id, "uncertain")
            return
          }
        }
        const now = new Date()
        const agents = [
          ...(yield* directory.managed(now, 90000)),
          ...(yield* directory.external(now)),
        ]
        const current = agents.find((agent) => agent.recipientId === record.message.recipient)
        if (
          current === undefined ||
          current.hostId !== record.target.hostId ||
          current.bindingVersion !== record.target.bindingVersion ||
          (current.endpoint !== null && !sameBinding(record.target, current))
        ) {
          yield* refuseUnsent(record.message.id, "stale_binding")
          return
        }
        if (!current.deliverable) return
        if (current.endpoint?.transport === "relay-http") {
          const owners = yield* directory.registrations()
          const owner = owners.find(
            (value) =>
              externalRecipientId(value.publicKey) === current.recipientId &&
              value.revision === current.bindingVersion,
          )
          if (owner === undefined) return
          const send = record.delivery === "pending" && (yield* messages.begin(record.message.id))
          const state = yield* deliverRelay(record, owner, !send)
          yield* messages.update(record.message.id, state)
          return
        }
        // Managed native delivery reuses the existing custodied queues. CLI sessions
        // have no attachable input channel and are explicitly unsupported.
        if (
          current.endpoint === null ||
          !["codex-app-server", "opencode-http"].includes(current.endpoint.transport)
        ) {
          yield* refuseUnsent(record.message.id, "unsupported")
          return
        }
        const thread = yield* inbox.read(current.endpoint.nativeSessionId)
        if (
          thread === null ||
          thread.run_id !== current.runId ||
          !["active", "waiting"].includes(thread.state) ||
          thread.closure_confirmed !== 0
        ) {
          yield* refuseUnsent(record.message.id, "unsupported")
          return
        }
        const id = `message:${record.message.id}`
        const state = yield* inbox.deliveryState(id)
        if (state === "delivered") yield* messages.update(record.message.id, "delivered")
        else if (state === "operator_required")
          yield* messages.update(record.message.id, "uncertain")
        else
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* inbox.enqueue(
                id,
                thread.thread_id,
                `workflowd message: ${canonicalJson(record.message)}`,
              )
              yield* messages.update(record.message.id, "queued")
            }),
          )
      },
      (effect) => effect.pipe(Effect.mapError(messagingError)),
    )
    let cursor: string | undefined
    const pass = Effect.fn("Messaging.deliveryPass")(function* () {
      const page = yield* messages.pending(cursor, hostId)
      cursor = page.at(-1)?.message.id
      for (const record of page) yield* deliver(record)
    })
    return { deliver, pass }
  })

export const MessageDeliveryLive = (hostId: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const delivery = yield* makeMessageDelivery(hostId)
      yield* delivery.pass().pipe(
        Effect.catch((error) => Effect.logError("Message delivery pass failed", error.reason)),
        Effect.repeat(Schedule.spaced("100 millis")),
        Effect.forkScoped,
      )
    }),
  )

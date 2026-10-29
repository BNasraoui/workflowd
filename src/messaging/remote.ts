import { createHash, timingSafeEqual } from "node:crypto"
import { Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { RemoteTransport } from "../remote/transport"
import { RemoteHostId, MAX_REMOTE_MESSAGE_BYTES } from "../remote/contract"
import type { DirectoryPeer } from "../directory/config"
import { directoryMac } from "../directory/wire"
import { canonicalJson } from "../kernel/session-store-support"
import {
  AgentMessage,
  DeliveryState,
  MessageId,
  MessageRecord,
  MessagingError,
  messagingError,
} from "./contract"
import { makeMessageStore } from "./store"
import { makeMessageDelivery } from "./delivery"

const EnvelopeFields = {
  version: Schema.Literal(1),
  fromHost: RemoteHostId,
  toHost: RemoteHostId,
  signature: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
}
const Deliver = Schema.Struct({
  ...EnvelopeFields,
  kind: Schema.Literal("agent_message"),
  message: AgentMessage,
  target: MessageRecord.fields.target,
})
const Receipt = Schema.Struct({
  ...EnvelopeFields,
  kind: Schema.Literal("agent_message_receipt"),
  id: MessageId,
  digest: Schema.String,
  delivery: DeliveryState,
})
const Envelope = Schema.Union([Deliver, Receipt])
const digest = (record: MessageRecord) =>
  createHash("sha256")
    .update(canonicalJson({ message: record.message, target: record.target }))
    .digest("hex")
const authentic = (credential: Redacted.Redacted<string>, message: typeof Envelope.Type) => {
  const { signature, ...document } = message
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(directoryMac(credential, document), "hex"),
  )
}

/** SQLite owns the outbox. JetStream acknowledgement only releases a transport
 * delivery, while an authenticated receipt advances application delivery state. */
export const makeMessageRemote = (hostId: string, peers: ReadonlyArray<DirectoryPeer>) =>
  Effect.gen(function* () {
    const transport = yield* RemoteTransport
    const store = yield* makeMessageStore
    const local = yield* makeMessageDelivery(hostId)
    const receive = transport.takeAgentMessages
    if (receive === undefined)
      return yield* Effect.die(new Error("Messaging requires the current command transport"))
    const publish = Effect.fn("Messaging.publishFrame")(function* (frame: typeof Envelope.Type) {
      const bytes = new TextEncoder().encode(JSON.stringify(frame))
      if (bytes.byteLength > MAX_REMOTE_MESSAGE_BYTES)
        return yield* Effect.fail(new MessagingError({ reason: "invalid" }))
      yield* transport.publishRaw(`workflowd.v1.commands.messages-${frame.toHost}`, bytes)
    })
    const respond = Effect.fn("Messaging.respond")(function* (
      record: MessageRecord,
      peer: DirectoryPeer,
    ) {
      const document = {
        version: 1 as const,
        kind: "agent_message_receipt" as const,
        fromHost: hostId,
        toHost: peer.hostId,
        id: record.message.id,
        digest: digest(record),
        delivery: record.delivery,
      }
      yield* publish({ ...document, signature: directoryMac(peer.credential, document) })
    })
    const handle = Effect.fn("Messaging.receiveFrame")(
      function* (bytes: Uint8Array) {
        if (bytes.byteLength > MAX_REMOTE_MESSAGE_BYTES) return
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(
          new TextDecoder().decode(bytes),
          { onExcessProperty: "error" },
        ).pipe(Effect.result)
        if (decoded._tag === "Failure") return
        const frame = decoded.success
        const peer = peers.find((peer) => peer.hostId === frame.fromHost)
        if (peer === undefined || frame.toHost !== hostId || !authentic(peer.credential, frame))
          return
        if (frame.kind === "agent_message") {
          if (
            frame.target.hostId !== hostId ||
            frame.target.recipientId !== frame.message.recipient
          )
            return
          yield* store.accept(frame.message, frame.target, frame.fromHost)
          const accepted = yield* store.read(frame.message.id)
          if (accepted === null) return
          yield* local.deliver(accepted)
          const current = yield* store.read(frame.message.id)
          if (current !== null) yield* respond(current, peer)
        } else {
          const current = yield* store.read(frame.id)
          if (
            current === null ||
            current.originHost !== hostId ||
            current.target.hostId !== peer.hostId ||
            digest(current) !== frame.digest
          )
            return
          yield* store.update(frame.id, frame.delivery)
        }
      },
      (effect) => effect.pipe(Effect.mapError(messagingError)),
    )
    let cursor: string | undefined
    const send = Effect.fn("Messaging.sendFrames")(function* () {
      yield* transport.ensureInfrastructure()
      const page = yield* store.pending(cursor, hostId, true)
      cursor = page.at(-1)?.message.id
      for (const record of page) {
        if (record.originHost !== hostId || record.target.hostId === hostId) continue
        const peer = peers.find((peer) => peer.hostId === record.target.hostId)
        if (peer === undefined) {
          yield* store.update(record.message.id, "unavailable")
          continue
        }
        const document = {
          version: 1 as const,
          kind: "agent_message" as const,
          fromHost: hostId,
          toHost: peer.hostId,
          message: record.message,
          target: record.target,
        }
        yield* publish({ ...document, signature: directoryMac(peer.credential, document) })
      }
    })
    const take = Effect.fn("Messaging.takeFrames")(function* () {
      for (const delivery of yield* receive(hostId, 1000)) {
        yield* handle(delivery.data)
        yield* delivery.acknowledge
      }
    })
    return { handle, send, take }
  })

export const MessageRemoteLive = (hostId: string, peers: ReadonlyArray<DirectoryPeer>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const remote = yield* makeMessageRemote(hostId, peers)
      yield* remote.send().pipe(
        Effect.catch(() =>
          Effect.logWarning("Message outbox transport unavailable; durable messages retained"),
        ),
        Effect.repeat(Schedule.spaced("500 millis")),
        Effect.forkScoped,
      )
      yield* remote.take().pipe(
        Effect.catch(() =>
          Effect.logWarning("Message inbox transport unavailable; durable messages retained"),
        ),
        Effect.repeat(Schedule.spaced("20 millis")),
        Effect.forkScoped,
      )
    }),
  )

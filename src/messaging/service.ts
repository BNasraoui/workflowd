import { Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import { AgentDirectory } from "../directory/service"
import { externalRecipientId, verifiesOwnerSignature } from "../directory/proof"
import { canonicalJson } from "../kernel/session-store-support"
import { makeMessageStore } from "./store"
import { SendMessage, MessageRecord, MessagingError, messagingError } from "./contract"
import { SubscribeEvent, PublishEvent, SubscriptionReceipt } from "./contract"
import { makeMessageSubscriptions } from "./subscriptions"

export const AgentMessaging = Context.Service<{
  readonly send: (
    input: SendMessage,
    authority?: { readonly runId: string },
  ) => Effect.Effect<
    { id: string; status: "accepted" | "duplicate"; delivery: MessageRecord["delivery"] },
    MessagingError
  >
  readonly read: (id: string) => Effect.Effect<MessageRecord, MessagingError>
  readonly subscribe: (
    input: SubscribeEvent,
  ) => Effect.Effect<typeof SubscriptionReceipt.Type, MessagingError>
  readonly cancel: (id: string) => Effect.Effect<SubscribeEvent & { state: string }, MessagingError>
  readonly subscription: (
    id: string,
  ) => Effect.Effect<SubscribeEvent & { state: string }, MessagingError>
  readonly publish: (
    input: typeof PublishEvent.Type,
  ) => Effect.Effect<{ id: string; status: "recorded" | "duplicate" }, MessagingError>
}>("workflowd/AgentMessaging")

export const AgentMessagingLive = (hostId: string) =>
  Layer.effect(
    AgentMessaging,
    Effect.gen(function* () {
      const directoryOption = yield* Effect.serviceOption(AgentDirectory)
      if (Option.isNone(directoryOption))
        return yield* Effect.die(new Error("Messaging requires the registered recipient directory"))
      const directory = directoryOption.value
      const store = yield* makeMessageStore
      const subscriptions = yield* makeMessageSubscriptions(hostId, directory)
      yield* subscriptions.reconcile().pipe(
        Effect.catch((error) => Effect.logError("Message event routing failed", error.reason)),
        Effect.repeat(Schedule.spaced("100 millis")),
        Effect.forkScoped,
      )
      const authorize = Effect.fn("AgentMessaging.authorize")(function* (
        input: SendMessage,
        authority?: { readonly runId: string },
      ) {
        if (authority !== undefined) {
          const snapshot = yield* directory.inventory().pipe(Effect.mapError(messagingError))
          if (
            input.message.sender !== `managed:${hostId}:${authority.runId}` ||
            !snapshot.agents.some(
              (agent) =>
                agent.recipientId === input.message.sender &&
                agent.origin === "managed" &&
                agent.hostId === hostId &&
                agent.runId === authority.runId &&
                agent.deliverable,
            )
          )
            return yield* Effect.fail(new MessagingError({ reason: "unauthorized" }))
          return
        }
        if (input.proof === undefined) {
          if (input.message.sender !== `host:${hostId}`)
            return yield* Effect.fail(new MessagingError({ reason: "unauthorized" }))
          return
        }
        const proof = input.proof
        const valid = yield* Effect.try({
          try: () =>
            externalRecipientId(proof.publicKey) === input.message.sender &&
            verifiesOwnerSignature(proof.publicKey, input.message, proof.signature),
          catch: () => new MessagingError({ reason: "unauthorized" }),
        })
        if (!valid) return yield* Effect.fail(new MessagingError({ reason: "unauthorized" }))
        const snapshot = yield* directory.inventory().pipe(Effect.mapError(messagingError))
        if (
          !snapshot.agents.some(
            (agent) =>
              agent.recipientId === input.message.sender &&
              agent.origin === "external" &&
              agent.status === "active",
          )
        )
          return yield* Effect.fail(new MessagingError({ reason: "unauthorized" }))
      })
      return AgentMessaging.of({
        subscribe: subscriptions.register,
        cancel: subscriptions.cancel,
        subscription: subscriptions.read,
        publish: subscriptions.publish,
        send: Effect.fn("AgentMessaging.send")(
          function* (input, authority) {
            const decoded = yield* Schema.decodeUnknownEffect(SendMessage)(input, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(() => new MessagingError({ reason: "invalid" })))
            if (Buffer.byteLength(canonicalJson(decoded)) > 8192)
              return yield* Effect.fail(new MessagingError({ reason: "invalid" }))
            yield* authorize(decoded, authority)
            // Identity replay uses the original route and historical receipt even when
            // the directory has subsequently expired or rebound.
            const existing = yield* store.read(decoded.message.id)
            if (existing !== null) {
              if (
                canonicalJson(existing.message) !== canonicalJson(decoded.message) ||
                existing.originHost !== hostId
              )
                return yield* Effect.fail(new MessagingError({ reason: "conflict" }))
              return {
                id: decoded.message.id,
                status: "duplicate" as const,
                delivery: existing.delivery,
              }
            }
            const snapshot = yield* directory.inventory().pipe(Effect.mapError(messagingError))
            const target = snapshot.agents.find(
              (agent) => agent.recipientId === decoded.message.recipient,
            )
            if (target === undefined || !target.deliverable || target.endpoint === null)
              return yield* Effect.fail(new MessagingError({ reason: "unavailable" }))
            if (decoded.message.replyTo !== null) {
              const reply = yield* store.read(decoded.message.replyTo)
              if (
                reply === null ||
                reply.message.sender !== decoded.message.recipient ||
                reply.message.recipient !== decoded.message.sender ||
                reply.message.correlation !== decoded.message.correlation
              )
                return yield* Effect.fail(new MessagingError({ reason: "conflict" }))
            }
            return yield* store.accept(decoded.message, target, hostId)
          },
          (effect) => effect.pipe(Effect.mapError(messagingError)),
        ),
        read: Effect.fn("AgentMessaging.read")(function* (id) {
          const row = yield* store.read(id)
          if (row === null) return yield* Effect.fail(new MessagingError({ reason: "not_found" }))
          return row
        }),
      })
    }),
  )

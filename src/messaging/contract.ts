import { Schema } from "effect"
import { AgentRecipient } from "../directory/contract"
import { JsonValueSchema } from "../json"
import { EventCondition, TypedEventEnvelope } from "../kernel/event-store-model"

export const MessageId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
)
const Identity = AgentRecipient.fields.recipientId
export const AgentMessage = Schema.Struct({
  id: MessageId,
  sender: Identity,
  recipient: Identity,
  correlation: Identity,
  replyTo: Schema.NullOr(MessageId),
  payload: Schema.Struct({
    type: EventCondition.fields.type,
    version: EventCondition.fields.version,
    data: JsonValueSchema,
  }),
})
export type AgentMessage = typeof AgentMessage.Type
export const SenderProof = Schema.Struct({
  publicKey: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
  signature: Schema.String.pipe(Schema.check(Schema.isMaxLength(256))),
})
export const SendMessage = Schema.Struct({
  message: AgentMessage,
  proof: Schema.optionalKey(SenderProof),
})
export type SendMessage = typeof SendMessage.Type
export const DeliveryState = Schema.Literals([
  "pending",
  "queued",
  "delivered",
  "unsupported",
  "unavailable",
  "stale_binding",
  "uncertain",
])
export type DeliveryState = typeof DeliveryState.Type
export const MessageRecord = Schema.Struct({
  message: AgentMessage,
  target: AgentRecipient,
  originHost: Schema.String,
  delivery: DeliveryState,
  relayIntent: Schema.Boolean,
  acceptedAt: Schema.String,
})
export type MessageRecord = typeof MessageRecord.Type
export const MessageReceipt = Schema.Struct({
  id: MessageId,
  status: Schema.Literals(["accepted", "duplicate"]),
  delivery: DeliveryState,
})
export const SubscribeEvent = Schema.Struct({
  id: MessageId,
  recipient: Identity,
  condition: EventCondition,
})
export type SubscribeEvent = typeof SubscribeEvent.Type
export const PublishEvent = Schema.Struct({ id: MessageId, event: TypedEventEnvelope })
export const SubscriptionReceipt = Schema.Struct({
  id: MessageId,
  status: Schema.Literals(["registered", "duplicate"]),
  state: Schema.Literals(["pending", "matched", "consumed", "cancelled"]),
})
export class MessagingError extends Schema.TaggedError<MessagingError>()("MessagingError", {
  reason: Schema.Literals([
    "unauthorized",
    "invalid",
    "conflict",
    "unavailable",
    "unsupported",
    "not_found",
  ]),
}) {}
export const messagingError = (error: unknown) =>
  error instanceof MessagingError ? error : new MessagingError({ reason: "unavailable" })

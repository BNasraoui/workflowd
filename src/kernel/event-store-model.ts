import { Schema } from "effect"
import { JsonValueSchema } from "../json"

export const MAX_KERNEL_PAYLOAD_BYTES = 65_536

const Identifier = Schema.NonEmptyString.pipe(Schema.maxLength(256))
const TypeName = Schema.NonEmptyString.pipe(Schema.maxLength(128))
const Version = Schema.Int.pipe(Schema.positive())
const Sequence = Schema.Int.pipe(Schema.nonNegative())

export const WorkflowInstanceInput = Schema.Struct({
  instanceId: Identifier,
  workflowType: TypeName,
  workflowVersion: Version,
  workflowKey: Identifier,
  payload: JsonValueSchema,
  createdAt: Schema.DateFromSelf,
})
export type WorkflowInstanceInput = typeof WorkflowInstanceInput.Type

export type CreateInstanceResult = {
  readonly status: "created" | "duplicate"
  readonly instance: WorkflowInstanceInput
}

export const EventCondition = Schema.Struct({
  type: TypeName,
  version: Version,
  key: Identifier,
})
export type EventCondition = typeof EventCondition.Type

export const TypedEventEnvelope = Schema.Struct({
  ...EventCondition.fields,
  payload: JsonValueSchema,
})
export type TypedEventEnvelope = typeof TypedEventEnvelope.Type

export const RecordEventInput = Schema.Struct({
  instanceId: Identifier,
  dedupeKey: Identifier,
  event: TypedEventEnvelope,
  recordedAt: Schema.DateFromSelf,
})
export type RecordEventInput = typeof RecordEventInput.Type

export const RegisterWaitInput = Schema.Struct({
  instanceId: Identifier,
  waitId: Identifier,
  condition: EventCondition,
  afterSequence: Sequence,
  registeredAt: Schema.DateFromSelf,
})
export type RegisterWaitInput = typeof RegisterWaitInput.Type

export type EventRecord = RecordEventInput & { readonly sequence: number }
export type WaitEventDelivery = {
  readonly instanceId: string
  readonly waitId: string
  readonly eventSequence: number
}
export type RecordEventResult = {
  readonly status: "recorded" | "duplicate"
  readonly event: EventRecord
  readonly deliveries: ReadonlyArray<WaitEventDelivery>
}
export type RegisterWaitResult = {
  readonly status: "registered" | "duplicate"
  readonly wait: RegisterWaitInput
  readonly deliveries: ReadonlyArray<WaitEventDelivery>
}

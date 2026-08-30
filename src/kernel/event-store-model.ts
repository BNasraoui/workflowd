import { Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"

export const MAX_KERNEL_IDENTIFIER_BYTES = 256
export const MAX_KERNEL_TYPE_BYTES = 128
export const MAX_KERNEL_SOURCE_BYTES = 128
export const MAX_KERNEL_PAYLOAD_BYTES = 65_536

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const boundedText = (bytes: number) =>
  Schema.NonEmptyString.pipe(
    Schema.check(
      Schema.makeFilter((value) => utf8Bytes(value) <= bytes, {
        message: `must be at most ${bytes} UTF-8 bytes`,
      }),
    ),
  )

const Identifier = boundedText(MAX_KERNEL_IDENTIFIER_BYTES)
const TypeName = boundedText(MAX_KERNEL_TYPE_BYTES)
const Source = boundedText(MAX_KERNEL_SOURCE_BYTES)
const Version = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

export const WorkflowInstanceInput = Schema.Struct({
  instanceId: Identifier,
  workflowType: TypeName,
  workflowVersion: Version,
  workflowKey: Identifier,
  payload: JsonValueSchema,
  createdAt: Schema.Date,
})
export type WorkflowInstanceInput = typeof WorkflowInstanceInput.Type
export type WorkflowInstanceRecord = WorkflowInstanceInput & { readonly eventCursor: number }
export type CreateInstanceResult = {
  readonly status: "created" | "duplicate"
  readonly instance: WorkflowInstanceRecord
}

export const EventCondition = Schema.Struct({
  type: TypeName,
  version: Version,
  key: Identifier,
  correlation: Identifier,
})
export type EventCondition = typeof EventCondition.Type

export const TypedEventEnvelope = Schema.Struct({
  ...EventCondition.fields,
  payload: JsonValueSchema,
})
export type TypedEventEnvelope = typeof TypedEventEnvelope.Type

export const RecordEventInput = Schema.Struct({
  source: Source,
  sourceEventId: Identifier,
  event: TypedEventEnvelope,
  recordedAt: Schema.Date,
})
export type RecordEventInput = typeof RecordEventInput.Type

export const RegisterWaitInput = Schema.Struct({
  instanceId: Identifier,
  waitId: Identifier,
  condition: EventCondition,
  registeredAt: Schema.Date,
})
export type RegisterWaitInput = typeof RegisterWaitInput.Type
export type WaitRecord = RegisterWaitInput & { readonly afterSequence: number }

export type EventRecord = RecordEventInput & { readonly sequence: number }
export type WaitEventDelivery = {
  readonly instanceId: string
  readonly waitId: string
  readonly eventSequence: number
}
export type ReadyWaitEventDelivery = WaitEventDelivery & {
  readonly event: {
    readonly source: string
    readonly sourceEventId: string
    readonly type: string
    readonly version: number
    readonly key: string
    readonly correlation: string
    readonly payload: JsonValue
    readonly recordedAt: Date
  }
}
export type RecordEventResult = {
  readonly status: "recorded" | "duplicate"
  readonly event: EventRecord
  readonly deliveries: ReadonlyArray<WaitEventDelivery>
}
export type RegisterWaitResult = {
  readonly status: "registered" | "duplicate"
  readonly wait: WaitRecord
  readonly deliveries: ReadonlyArray<WaitEventDelivery>
}

export const ConsumeDeliveryInput = Schema.Struct({
  instanceId: Identifier,
  waitId: Identifier,
  eventSequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  expectedCursor: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type ConsumeDeliveryInput = typeof ConsumeDeliveryInput.Type
export type ConsumeDeliveryResult = {
  readonly status: "consumed" | "duplicate"
  readonly eventCursor: number
}

import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Effect, Layer, Schema } from "effect"
import { JsonValueSchema } from "../json"
import { runStoreMigrations } from "../store/migrations"
import {
  KernelStoreConflictError,
  KernelStoreDataError,
  KernelStoreInputError,
} from "./event-store-errors"
import {
  type CreateInstanceResult,
  MAX_KERNEL_PAYLOAD_BYTES,
  type RecordEventInput,
  type RecordEventResult,
  RecordEventInput as RecordEventInputSchema,
  type RegisterWaitInput,
  type RegisterWaitResult,
  RegisterWaitInput as RegisterWaitInputSchema,
  WorkflowInstanceInput,
} from "./event-store-model"

export * from "./event-store-errors"
export * from "./event-store-model"

type KernelStoreError =
  SqlError | KernelStoreConflictError | KernelStoreDataError | KernelStoreInputError
const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
)

export type KernelEventStorePort = {
  readonly createInstance: (
    input: WorkflowInstanceInput,
  ) => Effect.Effect<CreateInstanceResult, KernelStoreError>
  readonly recordEvent: (
    input: RecordEventInput,
  ) => Effect.Effect<RecordEventResult, KernelStoreError>
  readonly registerWait: (
    input: RegisterWaitInput,
  ) => Effect.Effect<RegisterWaitResult, KernelStoreError>
}

export const KernelEventStore = Context.GenericTag<KernelEventStorePort>(
  "workflowd/kernel/KernelEventStore",
)

const InstanceRow = Schema.Struct({
  instance_id: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  workflow_type: Schema.NonEmptyString.pipe(Schema.maxLength(128)),
  workflow_version: Schema.Int.pipe(Schema.positive()),
  workflow_key: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  payload_json: Schema.parseJson(JsonValueSchema),
  created_at: Timestamp,
})
const EventRow = Schema.Struct({
  instance_id: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  sequence: Schema.Int.pipe(Schema.positive()),
  dedupe_key: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  event_type: Schema.NonEmptyString.pipe(Schema.maxLength(128)),
  event_version: Schema.Int.pipe(Schema.positive()),
  event_key: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  payload_json: Schema.parseJson(JsonValueSchema),
  recorded_at: Timestamp,
})
const WaitRow = Schema.Struct({
  instance_id: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  wait_id: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  event_type: Schema.NonEmptyString.pipe(Schema.maxLength(128)),
  event_version: Schema.Int.pipe(Schema.positive()),
  event_key: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  after_sequence: Schema.Int.pipe(Schema.nonNegative()),
  registered_at: Timestamp,
})
const DeliveryRow = Schema.Struct({
  instance_id: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  wait_id: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  event_sequence: Schema.Int.pipe(Schema.positive()),
})

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const inputError = (error: unknown) => new KernelStoreInputError({ message: String(error) })

const decodeInput = (input: WorkflowInstanceInput) =>
  Schema.decodeUnknown(WorkflowInstanceInput)(input).pipe(
    Effect.mapError(inputError),
    Effect.flatMap((decoded) => {
      const payloadJson = canonicalJson(decoded.payload)
      return new TextEncoder().encode(payloadJson).byteLength <= MAX_KERNEL_PAYLOAD_BYTES
        ? Effect.succeed({ decoded, payloadJson })
        : Effect.fail(new KernelStoreInputError({ message: "payload exceeds 65536 bytes" }))
    }),
  )

const decodeEventInput = (input: RecordEventInput) =>
  Schema.decodeUnknown(RecordEventInputSchema)(input).pipe(
    Effect.mapError(inputError),
    Effect.flatMap((decoded) => {
      const payloadJson = canonicalJson(decoded.event.payload)
      return new TextEncoder().encode(payloadJson).byteLength <= MAX_KERNEL_PAYLOAD_BYTES
        ? Effect.succeed({ decoded, payloadJson })
        : Effect.fail(new KernelStoreInputError({ message: "payload exceeds 65536 bytes" }))
    }),
  )

const dataError =
  (record: "delivery" | "event" | "wait", instanceId: string, key: string) => (error: unknown) =>
    new KernelStoreDataError({ record, instanceId, key, message: String(error) })

const decodeDeliveries = (rows: ReadonlyArray<unknown>, instanceId: string, key: string) =>
  Effect.forEach(rows, (row) =>
    Schema.decodeUnknown(DeliveryRow)(row).pipe(
      Effect.mapError(dataError("delivery", instanceId, key)),
      Effect.map((decoded) => ({
        instanceId: decoded.instance_id,
        waitId: decoded.wait_id,
        eventSequence: decoded.event_sequence,
      })),
    ),
  )

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`PRAGMA busy_timeout = 5000`
  yield* runStoreMigrations

  const createInstance: KernelEventStorePort["createInstance"] = (input) =>
    Effect.gen(function* () {
      const { decoded, payloadJson } = yield* decodeInput(input)
      const createdAt = decoded.createdAt.toISOString()
      const inserted = yield* sql`
        INSERT OR IGNORE INTO kernel_workflow_instances (
          instance_id, workflow_type, workflow_version, workflow_key, payload_json, created_at
        ) VALUES (
          ${decoded.instanceId}, ${decoded.workflowType}, ${decoded.workflowVersion},
          ${decoded.workflowKey}, ${payloadJson}, ${createdAt}
        )
        RETURNING instance_id
      `
      if (inserted.length > 0) return { status: "created" as const, instance: decoded }

      const rows = yield* sql`SELECT * FROM kernel_workflow_instances
        WHERE instance_id = ${decoded.instanceId}`
      const row = yield* Schema.decodeUnknown(InstanceRow)(rows[0]).pipe(
        Effect.mapError(
          (error) =>
            new KernelStoreDataError({
              record: "instance",
              instanceId: decoded.instanceId,
              key: decoded.instanceId,
              message: String(error),
            }),
        ),
      )
      if (
        row.workflow_type !== decoded.workflowType ||
        row.workflow_version !== decoded.workflowVersion ||
        row.workflow_key !== decoded.workflowKey ||
        canonicalJson(row.payload_json) !== payloadJson ||
        row.created_at !== createdAt
      ) {
        return yield* new KernelStoreConflictError({
          record: "instance",
          instanceId: decoded.instanceId,
          key: decoded.instanceId,
        })
      }
      return { status: "duplicate" as const, instance: decoded }
    }).pipe(sql.withTransaction)

  const recordEvent: KernelEventStorePort["recordEvent"] = (input) =>
    Effect.gen(function* () {
      const { decoded, payloadJson } = yield* decodeEventInput(input)
      const existingRows = yield* sql`SELECT * FROM kernel_events
        WHERE instance_id = ${decoded.instanceId} AND dedupe_key = ${decoded.dedupeKey}`
      let status: "recorded" | "duplicate" = "recorded"
      let sequence: number
      if (existingRows.length > 0) {
        const row = yield* Schema.decodeUnknown(EventRow)(existingRows[0]).pipe(
          Effect.mapError(dataError("event", decoded.instanceId, decoded.dedupeKey)),
        )
        if (
          row.event_type !== decoded.event.type ||
          row.event_version !== decoded.event.version ||
          row.event_key !== decoded.event.key ||
          canonicalJson(row.payload_json) !== payloadJson ||
          row.recorded_at !== decoded.recordedAt.toISOString()
        ) {
          return yield* new KernelStoreConflictError({
            record: "event",
            instanceId: decoded.instanceId,
            key: decoded.dedupeKey,
          })
        }
        status = "duplicate"
        sequence = row.sequence
      } else {
        const inserted = yield* sql<{ readonly sequence: number }>`
          INSERT INTO kernel_events (
            instance_id, sequence, dedupe_key, event_type, event_version, event_key,
            payload_json, recorded_at
          ) SELECT
            ${decoded.instanceId}, COALESCE(MAX(sequence), 0) + 1, ${decoded.dedupeKey},
            ${decoded.event.type}, ${decoded.event.version}, ${decoded.event.key},
            ${payloadJson}, ${decoded.recordedAt.toISOString()}
          FROM kernel_events WHERE instance_id = ${decoded.instanceId}
          RETURNING sequence
        `
        sequence = inserted[0]!.sequence
        const matchingWaits = yield* sql`SELECT * FROM kernel_waits
          WHERE instance_id = ${decoded.instanceId}
            AND event_type = ${decoded.event.type}
            AND event_version = ${decoded.event.version}
            AND event_key = ${decoded.event.key}
            AND after_sequence < ${sequence}`
        yield* Effect.forEach(matchingWaits, (row) =>
          Schema.decodeUnknown(WaitRow)(row).pipe(
            Effect.mapError(dataError("wait", decoded.instanceId, decoded.dedupeKey)),
          ),
        )
        yield* sql`
          INSERT OR IGNORE INTO kernel_wait_event_deliveries (
            instance_id, wait_id, event_sequence, delivered_at
          )
          SELECT instance_id, wait_id, ${sequence}, ${decoded.recordedAt.toISOString()}
          FROM kernel_waits
          WHERE instance_id = ${decoded.instanceId}
            AND event_type = ${decoded.event.type}
            AND event_version = ${decoded.event.version}
            AND event_key = ${decoded.event.key}
            AND after_sequence < ${sequence}
        `
      }
      const deliveryRows = yield* sql`SELECT instance_id, wait_id, event_sequence
        FROM kernel_wait_event_deliveries
        WHERE instance_id = ${decoded.instanceId} AND event_sequence = ${sequence}
        ORDER BY wait_id`
      const deliveries = yield* decodeDeliveries(
        deliveryRows,
        decoded.instanceId,
        decoded.dedupeKey,
      )
      return { status, event: { ...decoded, sequence }, deliveries }
    }).pipe(sql.withTransaction)

  const registerWait: KernelEventStorePort["registerWait"] = (input) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(RegisterWaitInputSchema)(input).pipe(
        Effect.mapError(inputError),
      )
      const inserted = yield* sql`
        INSERT OR IGNORE INTO kernel_waits (
          instance_id, wait_id, event_type, event_version, event_key,
          after_sequence, registered_at
        ) VALUES (
          ${decoded.instanceId}, ${decoded.waitId}, ${decoded.condition.type},
          ${decoded.condition.version}, ${decoded.condition.key}, ${decoded.afterSequence},
          ${decoded.registeredAt.toISOString()}
        ) RETURNING wait_id
      `
      if (inserted.length === 0) {
        const rows = yield* sql`SELECT * FROM kernel_waits
          WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}`
        const row = yield* Schema.decodeUnknown(WaitRow)(rows[0]).pipe(
          Effect.mapError(dataError("wait", decoded.instanceId, decoded.waitId)),
        )
        if (
          row.event_type !== decoded.condition.type ||
          row.event_version !== decoded.condition.version ||
          row.event_key !== decoded.condition.key ||
          row.after_sequence !== decoded.afterSequence ||
          row.registered_at !== decoded.registeredAt.toISOString()
        ) {
          return yield* new KernelStoreConflictError({
            record: "wait",
            instanceId: decoded.instanceId,
            key: decoded.waitId,
          })
        }
      } else {
        const matchingEvents = yield* sql`SELECT * FROM kernel_events
          WHERE instance_id = ${decoded.instanceId}
            AND event_type = ${decoded.condition.type}
            AND event_version = ${decoded.condition.version}
            AND event_key = ${decoded.condition.key}
            AND sequence > ${decoded.afterSequence}`
        yield* Effect.forEach(matchingEvents, (row) =>
          Schema.decodeUnknown(EventRow)(row).pipe(
            Effect.mapError(dataError("event", decoded.instanceId, decoded.waitId)),
          ),
        )
        yield* sql`
          INSERT OR IGNORE INTO kernel_wait_event_deliveries (
            instance_id, wait_id, event_sequence, delivered_at
          )
          SELECT instance_id, ${decoded.waitId}, sequence, recorded_at
          FROM kernel_events
          WHERE instance_id = ${decoded.instanceId}
            AND event_type = ${decoded.condition.type}
            AND event_version = ${decoded.condition.version}
            AND event_key = ${decoded.condition.key}
            AND sequence > ${decoded.afterSequence}
        `
      }
      const deliveryRows = yield* sql`SELECT instance_id, wait_id, event_sequence
        FROM kernel_wait_event_deliveries
        WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}
        ORDER BY event_sequence`
      const deliveries = yield* decodeDeliveries(deliveryRows, decoded.instanceId, decoded.waitId)
      return {
        status: inserted.length > 0 ? ("registered" as const) : ("duplicate" as const),
        wait: decoded,
        deliveries,
      }
    }).pipe(sql.withTransaction)

  return KernelEventStore.of({
    createInstance,
    recordEvent,
    registerWait,
  })
})

export const KernelEventStoreLive = Layer.effect(KernelEventStore, make)

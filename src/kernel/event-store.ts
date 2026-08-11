import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { JsonValueSchema } from "../json"
import {
  type CreateInstanceResult,
  MAX_KERNEL_PAYLOAD_BYTES,
  type ReadyWaitEventDelivery,
  type RecordEventInput,
  type RecordEventResult,
  RecordEventInput as RecordEventInputSchema,
  type RegisterWaitInput,
  type RegisterWaitResult,
  RegisterWaitInput as RegisterWaitInputSchema,
  WorkflowInstanceInput,
} from "./event-store-model"

export * from "./event-store-model"

export class KernelStoreInputError extends Data.TaggedError("KernelStoreInputError")<{
  readonly message: string
}> {}

export class KernelStoreConflictError extends Data.TaggedError("KernelStoreConflictError")<{
  readonly record: "event" | "instance" | "wait"
  readonly key: string
  readonly instanceId?: string
}> {}

export class KernelStoreDataError extends Data.TaggedError("KernelStoreDataError")<{
  readonly record: "delivery" | "event" | "instance" | "wait"
  readonly key: string
  readonly message: string
  readonly instanceId?: string
}> {}

type KernelStoreError =
  SqlError | KernelStoreConflictError | KernelStoreDataError | KernelStoreInputError

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
  readonly readReadyDeliveries: (
    instanceId: string,
  ) => Effect.Effect<ReadonlyArray<ReadyWaitEventDelivery>, KernelStoreError>
}

export const KernelEventStore = Context.GenericTag<KernelEventStorePort>(
  "workflowd/kernel/KernelEventStore",
)

const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
)
const Identifier = WorkflowInstanceInput.fields.instanceId
const TypeName = WorkflowInstanceInput.fields.workflowType
const PositiveSequence = Schema.Int.pipe(Schema.positive())
const NonNegativeSequence = Schema.Int.pipe(Schema.nonNegative())
const JsonText = Schema.parseJson(JsonValueSchema)

const InstanceRow = Schema.Struct({
  instance_id: Identifier,
  workflow_type: TypeName,
  workflow_version: Schema.Int.pipe(Schema.positive()),
  workflow_key: Identifier,
  payload_json: JsonText,
  start_sequence: NonNegativeSequence,
  created_at: Timestamp,
})
const EventRow = Schema.Struct({
  sequence: PositiveSequence,
  source: RecordEventInputSchema.fields.source,
  source_event_id: RecordEventInputSchema.fields.sourceEventId,
  event_type: RecordEventInputSchema.fields.event.fields.type,
  event_version: Schema.Int.pipe(Schema.positive()),
  correlation: Identifier,
  payload_json: JsonText,
  recorded_at: Timestamp,
})
const WaitRow = Schema.Struct({
  instance_id: Identifier,
  wait_id: Identifier,
  event_type: RegisterWaitInputSchema.fields.condition.fields.type,
  event_version: Schema.Int.pipe(Schema.positive()),
  correlation: Identifier,
  after_sequence: NonNegativeSequence,
  registered_at: Timestamp,
})
const DeliveryRow = Schema.Struct({
  instance_id: Identifier,
  wait_id: Identifier,
  event_sequence: PositiveSequence,
})
const ReadyDeliveryRow = Schema.Struct({
  ...DeliveryRow.fields,
  source: RecordEventInputSchema.fields.source,
  source_event_id: RecordEventInputSchema.fields.sourceEventId,
  event_type: RecordEventInputSchema.fields.event.fields.type,
  event_version: Schema.Int.pipe(Schema.positive()),
  correlation: Identifier,
  payload_json: JsonText,
  recorded_at: Timestamp,
})

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const inputError = (error: unknown) => new KernelStoreInputError({ message: String(error) })
const dataError =
  (record: KernelStoreDataError["record"], key: string, instanceId?: string) => (error: unknown) =>
    new KernelStoreDataError({
      record,
      key,
      message: String(error),
      ...(instanceId === undefined ? {} : { instanceId }),
    })

const boundedPayload = <A>(decoded: A, payload: unknown) => {
  const payloadJson = canonicalJson(payload)
  return new TextEncoder().encode(payloadJson).byteLength <= MAX_KERNEL_PAYLOAD_BYTES
    ? Effect.succeed({ decoded, payloadJson })
    : Effect.fail(new KernelStoreInputError({ message: "payload exceeds 65536 bytes" }))
}

const decodeInstanceInput = (input: WorkflowInstanceInput) =>
  Schema.decodeUnknown(WorkflowInstanceInput)(input).pipe(
    Effect.mapError(inputError),
    Effect.flatMap((decoded) => boundedPayload(decoded, decoded.payload)),
  )

const decodeEventInput = (input: RecordEventInput) =>
  Schema.decodeUnknown(RecordEventInputSchema)(input).pipe(
    Effect.mapError(inputError),
    Effect.flatMap((decoded) => boundedPayload(decoded, decoded.event.payload)),
  )

const toDelivery = (row: typeof DeliveryRow.Type) => ({
  instanceId: row.instance_id,
  waitId: row.wait_id,
  eventSequence: row.event_sequence,
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`PRAGMA busy_timeout = 5000`

  const decodeDeliveries = (rows: ReadonlyArray<unknown>, key: string, instanceId?: string) =>
    Effect.forEach(rows, (row) =>
      Schema.decodeUnknown(DeliveryRow)(row).pipe(
        Effect.mapError(dataError("delivery", key, instanceId)),
        Effect.map(toDelivery),
      ),
    )

  const createInstance: KernelEventStorePort["createInstance"] = (input) =>
    Effect.gen(function* () {
      const { decoded, payloadJson } = yield* decodeInstanceInput(input)
      const inserted = yield* sql<{ readonly start_sequence: number }>`
        INSERT INTO kernel_workflow_instances (
          instance_id, workflow_type, workflow_version, workflow_key, payload_json,
          start_sequence, created_at
        ) VALUES (
          ${decoded.instanceId}, ${decoded.workflowType}, ${decoded.workflowVersion},
          ${decoded.workflowKey}, ${payloadJson},
          COALESCE((SELECT MAX(sequence) FROM kernel_events), 0),
          ${decoded.createdAt.toISOString()}
        )
        ON CONFLICT (instance_id) DO NOTHING
        RETURNING start_sequence
      `
      if (inserted.length > 0) {
        return {
          status: "created" as const,
          instance: { ...decoded, startSequence: inserted[0]!.start_sequence },
        }
      }
      const rows = yield* sql`SELECT * FROM kernel_workflow_instances
        WHERE instance_id = ${decoded.instanceId}`
      const row = yield* Schema.decodeUnknown(InstanceRow)(rows[0]).pipe(
        Effect.mapError(dataError("instance", decoded.instanceId, decoded.instanceId)),
      )
      if (
        row.workflow_type !== decoded.workflowType ||
        row.workflow_version !== decoded.workflowVersion ||
        row.workflow_key !== decoded.workflowKey ||
        canonicalJson(row.payload_json) !== payloadJson ||
        row.created_at !== decoded.createdAt.toISOString()
      ) {
        return yield* new KernelStoreConflictError({
          record: "instance",
          key: decoded.instanceId,
          instanceId: decoded.instanceId,
        })
      }
      return {
        status: "duplicate" as const,
        instance: { ...decoded, startSequence: row.start_sequence },
      }
    }).pipe(sql.withTransaction)

  const recordEvent: KernelEventStorePort["recordEvent"] = (input) =>
    Effect.gen(function* () {
      const { decoded, payloadJson } = yield* decodeEventInput(input)
      const inserted = yield* sql<{ readonly sequence: number }>`
          INSERT INTO kernel_events (
            sequence, source, source_event_id, event_type, event_version, correlation,
            payload_json, recorded_at
          ) VALUES (
            COALESCE(
              (SELECT sequence FROM kernel_events
                WHERE source = ${decoded.source} AND source_event_id = ${decoded.sourceEventId}),
              (SELECT COALESCE(MAX(sequence), 0) + 1 FROM kernel_events)
            ),
            ${decoded.source}, ${decoded.sourceEventId}, ${decoded.event.type},
            ${decoded.event.version}, ${decoded.event.correlation}, ${payloadJson},
            ${decoded.recordedAt.toISOString()}
          )
          ON CONFLICT (source, source_event_id) DO NOTHING
          RETURNING sequence
        `.pipe(
        Effect.mapError((error) =>
          String(error.cause).includes("kernel event immutable conflict")
            ? new KernelStoreConflictError({
                record: "event",
                key: `${decoded.source}:${decoded.sourceEventId}`,
              })
            : error,
        ),
      )
      let status: "recorded" | "duplicate"
      let sequence: number
      if (inserted.length > 0) {
        status = "recorded"
        sequence = inserted[0]!.sequence
        const pendingWaits = yield* sql`SELECT wait.* FROM kernel_waits AS wait
          LEFT JOIN kernel_wait_event_deliveries AS delivery
            ON delivery.instance_id = wait.instance_id AND delivery.wait_id = wait.wait_id
          WHERE delivery.wait_id IS NULL
            AND wait.event_type = ${decoded.event.type}
            AND wait.event_version = ${decoded.event.version}
            AND wait.correlation = ${decoded.event.correlation}
            AND wait.after_sequence < ${sequence}`
        yield* Effect.forEach(pendingWaits, (row) =>
          Schema.decodeUnknown(WaitRow)(row).pipe(
            Effect.mapError(dataError("wait", decoded.sourceEventId)),
          ),
        )
        yield* sql`
          INSERT INTO kernel_wait_event_deliveries (
            instance_id, wait_id, event_sequence, delivered_at
          )
          SELECT wait.instance_id, wait.wait_id, ${sequence}, ${decoded.recordedAt.toISOString()}
          FROM kernel_waits AS wait
          LEFT JOIN kernel_wait_event_deliveries AS delivery
            ON delivery.instance_id = wait.instance_id AND delivery.wait_id = wait.wait_id
          WHERE delivery.wait_id IS NULL
            AND wait.event_type = ${decoded.event.type}
            AND wait.event_version = ${decoded.event.version}
            AND wait.correlation = ${decoded.event.correlation}
            AND wait.after_sequence < ${sequence}
          ON CONFLICT (instance_id, wait_id) DO NOTHING
        `
      } else {
        status = "duplicate"
        const rows = yield* sql`SELECT * FROM kernel_events
          WHERE source = ${decoded.source} AND source_event_id = ${decoded.sourceEventId}`
        const row = yield* Schema.decodeUnknown(EventRow)(rows[0]).pipe(
          Effect.mapError(dataError("event", `${decoded.source}:${decoded.sourceEventId}`)),
        )
        if (
          row.event_type !== decoded.event.type ||
          row.event_version !== decoded.event.version ||
          row.correlation !== decoded.event.correlation ||
          canonicalJson(row.payload_json) !== payloadJson ||
          row.recorded_at !== decoded.recordedAt.toISOString()
        ) {
          return yield* new KernelStoreConflictError({
            record: "event",
            key: `${decoded.source}:${decoded.sourceEventId}`,
          })
        }
        sequence = row.sequence
      }
      const deliveryRows = yield* sql`SELECT instance_id, wait_id, event_sequence
        FROM kernel_wait_event_deliveries WHERE event_sequence = ${sequence}
        ORDER BY instance_id, wait_id`
      const deliveries = yield* decodeDeliveries(
        deliveryRows,
        `${decoded.source}:${decoded.sourceEventId}`,
      )
      return { status, event: { ...decoded, sequence }, deliveries }
    }).pipe(sql.withTransaction)

  const registerWait: KernelEventStorePort["registerWait"] = (input) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(RegisterWaitInputSchema)(input).pipe(
        Effect.mapError(inputError),
      )
      const instanceRows = yield* sql`SELECT * FROM kernel_workflow_instances
        WHERE instance_id = ${decoded.instanceId}`
      const instance = yield* Schema.decodeUnknown(InstanceRow)(instanceRows[0]).pipe(
        Effect.mapError(dataError("instance", decoded.instanceId, decoded.instanceId)),
      )
      const inserted = yield* sql`
        INSERT INTO kernel_waits (
          instance_id, wait_id, event_type, event_version, correlation,
          after_sequence, registered_at
        ) VALUES (
          ${decoded.instanceId}, ${decoded.waitId}, ${decoded.condition.type},
          ${decoded.condition.version}, ${decoded.condition.correlation},
          ${instance.start_sequence}, ${decoded.registeredAt.toISOString()}
        )
        ON CONFLICT (instance_id, wait_id) DO NOTHING
        RETURNING wait_id
      `
      let wait: typeof WaitRow.Type
      if (inserted.length > 0) {
        wait = {
          instance_id: decoded.instanceId,
          wait_id: decoded.waitId,
          event_type: decoded.condition.type,
          event_version: decoded.condition.version,
          correlation: decoded.condition.correlation,
          after_sequence: instance.start_sequence,
          registered_at: decoded.registeredAt.toISOString(),
        }
        const eventRows = yield* sql`SELECT * FROM kernel_events
          WHERE event_type = ${decoded.condition.type}
            AND event_version = ${decoded.condition.version}
            AND correlation = ${decoded.condition.correlation}
            AND sequence > ${instance.start_sequence}
          ORDER BY sequence LIMIT 1`
        if (eventRows.length > 0) {
          const event = yield* Schema.decodeUnknown(EventRow)(eventRows[0]).pipe(
            Effect.mapError(dataError("event", decoded.waitId, decoded.instanceId)),
          )
          yield* sql`
            INSERT INTO kernel_wait_event_deliveries (
              instance_id, wait_id, event_sequence, delivered_at
            ) VALUES (
              ${decoded.instanceId}, ${decoded.waitId}, ${event.sequence}, ${event.recorded_at}
            )
            ON CONFLICT (instance_id, wait_id) DO NOTHING
          `
        }
      } else {
        const rows = yield* sql`SELECT * FROM kernel_waits
          WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}`
        wait = yield* Schema.decodeUnknown(WaitRow)(rows[0]).pipe(
          Effect.mapError(dataError("wait", decoded.waitId, decoded.instanceId)),
        )
        if (
          wait.event_type !== decoded.condition.type ||
          wait.event_version !== decoded.condition.version ||
          wait.correlation !== decoded.condition.correlation ||
          wait.registered_at !== decoded.registeredAt.toISOString()
        ) {
          return yield* new KernelStoreConflictError({
            record: "wait",
            key: decoded.waitId,
            instanceId: decoded.instanceId,
          })
        }
      }
      const deliveryRows = yield* sql`SELECT instance_id, wait_id, event_sequence
        FROM kernel_wait_event_deliveries
        WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}`
      const deliveries = yield* decodeDeliveries(deliveryRows, decoded.waitId, decoded.instanceId)
      return {
        status: inserted.length > 0 ? ("registered" as const) : ("duplicate" as const),
        wait: {
          ...decoded,
          afterSequence: wait.after_sequence,
        },
        deliveries,
      }
    }).pipe(sql.withTransaction)

  const readReadyDeliveries: KernelEventStorePort["readReadyDeliveries"] = (instanceId) =>
    Schema.decodeUnknown(Identifier)(instanceId).pipe(
      Effect.mapError(inputError),
      Effect.flatMap((decodedInstanceId) =>
        sql`SELECT
          delivery.instance_id, delivery.wait_id, delivery.event_sequence,
          event.source, event.source_event_id, event.event_type, event.event_version,
          event.correlation, event.payload_json, event.recorded_at
        FROM kernel_wait_event_deliveries AS delivery
        JOIN kernel_events AS event ON event.sequence = delivery.event_sequence
        WHERE delivery.instance_id = ${decodedInstanceId}
        ORDER BY delivery.event_sequence, delivery.wait_id`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Schema.decodeUnknown(ReadyDeliveryRow)(row).pipe(
                Effect.mapError(dataError("delivery", decodedInstanceId, decodedInstanceId)),
                Effect.map((decoded) => ({
                  ...toDelivery(decoded),
                  event: {
                    source: decoded.source,
                    sourceEventId: decoded.source_event_id,
                    type: decoded.event_type,
                    version: decoded.event_version,
                    correlation: decoded.correlation,
                    payload: decoded.payload_json,
                    recordedAt: new Date(decoded.recorded_at),
                  },
                })),
              ),
            ),
          ),
        ),
      ),
    )

  return KernelEventStore.of({
    createInstance,
    recordEvent,
    registerWait,
    readReadyDeliveries,
  })
})

/** Requires a SqlClient whose shared WorkflowStore bootstrap has already run migrations. */
export const KernelEventStoreLive = Layer.effect(KernelEventStore, make)

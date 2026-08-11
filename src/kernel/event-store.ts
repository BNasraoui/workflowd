import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { JsonValueSchema } from "../json"
import {
  type ConsumeDeliveryInput,
  type ConsumeDeliveryResult,
  ConsumeDeliveryInput as ConsumeDeliveryInputSchema,
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
  readonly consumeDelivery: (
    input: ConsumeDeliveryInput,
  ) => Effect.Effect<ConsumeDeliveryResult, KernelStoreError>
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
  event_cursor: NonNegativeSequence,
  created_at: Timestamp,
})
const EventRow = Schema.Struct({
  sequence: PositiveSequence,
  source: RecordEventInputSchema.fields.source,
  source_event_id: RecordEventInputSchema.fields.sourceEventId,
  event_type: RecordEventInputSchema.fields.event.fields.type,
  event_version: Schema.Int.pipe(Schema.positive()),
  event_key: Identifier,
  correlation: Identifier,
  payload_json: JsonText,
  recorded_at: Timestamp,
})
const WaitRow = Schema.Struct({
  instance_id: Identifier,
  wait_id: Identifier,
  event_type: RegisterWaitInputSchema.fields.condition.fields.type,
  event_version: Schema.Int.pipe(Schema.positive()),
  event_key: Identifier,
  correlation: Identifier,
  after_sequence: NonNegativeSequence,
  state: Schema.Literal("pending", "matched", "consumed", "cancelled"),
  registered_at: Timestamp,
})
const DeliveryRow = Schema.Struct({
  instance_id: Identifier,
  wait_id: Identifier,
  event_sequence: PositiveSequence,
  state: Schema.Literal("ready", "consumed", "cancelled"),
})
const ReadyDeliveryRow = Schema.Struct({
  ...DeliveryRow.fields,
  source: RecordEventInputSchema.fields.source,
  source_event_id: RecordEventInputSchema.fields.sourceEventId,
  event_type: RecordEventInputSchema.fields.event.fields.type,
  event_version: Schema.Int.pipe(Schema.positive()),
  event_key: Identifier,
  correlation: Identifier,
  payload_json: JsonText,
  recorded_at: Timestamp,
})
const ConsumeStateRow = Schema.Struct({
  event_cursor: NonNegativeSequence,
  event_sequence: PositiveSequence,
  after_sequence: NonNegativeSequence,
  delivery_state: Schema.Literal("ready", "consumed", "cancelled"),
  wait_state: Schema.Literal("pending", "matched", "consumed", "cancelled"),
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
      const inserted = yield* sql<{ readonly event_cursor: number }>`
        INSERT INTO kernel_workflow_instances (
          instance_id, workflow_type, workflow_version, workflow_key, payload_json,
          event_cursor, created_at
        ) VALUES (
          ${decoded.instanceId}, ${decoded.workflowType}, ${decoded.workflowVersion},
          ${decoded.workflowKey}, ${payloadJson},
          COALESCE((SELECT MAX(sequence) FROM kernel_events), 0),
          ${decoded.createdAt.toISOString()}
        )
        ON CONFLICT (instance_id) DO NOTHING
        RETURNING event_cursor
      `
      if (inserted.length > 0) {
        return {
          status: "created" as const,
          instance: { ...decoded, eventCursor: inserted[0]!.event_cursor },
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
        canonicalJson(row.payload_json) !== payloadJson
      ) {
        return yield* new KernelStoreConflictError({
          record: "instance",
          key: decoded.instanceId,
          instanceId: decoded.instanceId,
        })
      }
      return {
        status: "duplicate" as const,
        instance: {
          ...decoded,
          payload: row.payload_json,
          createdAt: new Date(row.created_at),
          eventCursor: row.event_cursor,
        },
      }
    }).pipe(sql.withTransaction)

  const recordEvent: KernelEventStorePort["recordEvent"] = (input) =>
    Effect.gen(function* () {
      const { decoded, payloadJson } = yield* decodeEventInput(input)
      const inserted = yield* sql<{ readonly sequence: number }>`
          INSERT INTO kernel_events (
            sequence, source, source_event_id, event_type, event_version, event_key,
            correlation, payload_json, recorded_at
          ) VALUES (
            COALESCE(
              (SELECT sequence FROM kernel_events
                WHERE source = ${decoded.source} AND source_event_id = ${decoded.sourceEventId}),
              (SELECT COALESCE(MAX(sequence), 0) + 1 FROM kernel_events)
            ),
            ${decoded.source}, ${decoded.sourceEventId}, ${decoded.event.type},
            ${decoded.event.version}, ${decoded.event.key}, ${decoded.event.correlation},
            ${payloadJson}, ${decoded.recordedAt.toISOString()}
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
            AND wait.state = 'pending'
            AND wait.event_type = ${decoded.event.type}
            AND wait.event_version = ${decoded.event.version}
            AND wait.event_key = ${decoded.event.key}
            AND wait.correlation = ${decoded.event.correlation}
            AND wait.after_sequence < ${sequence}`
        yield* Effect.forEach(pendingWaits, (row) =>
          Schema.decodeUnknown(WaitRow)(row).pipe(
            Effect.mapError(dataError("wait", decoded.sourceEventId)),
          ),
        )
        yield* sql`
          INSERT INTO kernel_wait_event_deliveries (
            instance_id, wait_id, event_sequence, state, delivered_at
          )
          SELECT wait.instance_id, wait.wait_id, ${sequence}, 'ready',
            ${decoded.recordedAt.toISOString()}
          FROM kernel_waits AS wait
          LEFT JOIN kernel_wait_event_deliveries AS delivery
            ON delivery.instance_id = wait.instance_id AND delivery.wait_id = wait.wait_id
          WHERE delivery.wait_id IS NULL
            AND wait.state = 'pending'
            AND wait.event_type = ${decoded.event.type}
            AND wait.event_version = ${decoded.event.version}
            AND wait.event_key = ${decoded.event.key}
            AND wait.correlation = ${decoded.event.correlation}
            AND wait.after_sequence < ${sequence}
          ON CONFLICT (instance_id, wait_id) DO NOTHING
        `
        yield* sql`
          UPDATE kernel_waits AS wait
          SET state = 'matched'
          WHERE state = 'pending'
            AND EXISTS (
              SELECT 1 FROM kernel_wait_event_deliveries AS delivery
              WHERE delivery.instance_id = wait.instance_id
                AND delivery.wait_id = wait.wait_id
                AND delivery.event_sequence = ${sequence}
                AND delivery.state = 'ready'
            )
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
          row.event_key !== decoded.event.key ||
          row.correlation !== decoded.event.correlation ||
          canonicalJson(row.payload_json) !== payloadJson
        ) {
          return yield* new KernelStoreConflictError({
            record: "event",
            key: `${decoded.source}:${decoded.sourceEventId}`,
          })
        }
        sequence = row.sequence
        return {
          status,
          event: {
            source: row.source,
            sourceEventId: row.source_event_id,
            event: {
              type: row.event_type,
              version: row.event_version,
              key: row.event_key,
              correlation: row.correlation,
              payload: row.payload_json,
            },
            recordedAt: new Date(row.recorded_at),
            sequence,
          },
          deliveries: [],
        }
      }
      const deliveryRows = yield* sql`SELECT instance_id, wait_id, event_sequence, state
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
      const inserted = yield* sql`
        INSERT INTO kernel_waits (
          instance_id, wait_id, event_type, event_version, event_key, correlation,
          after_sequence, state, registered_at
        )
        SELECT
          ${decoded.instanceId}, ${decoded.waitId}, ${decoded.condition.type},
          ${decoded.condition.version}, ${decoded.condition.key},
          ${decoded.condition.correlation},
          event_cursor, 'pending', ${decoded.registeredAt.toISOString()}
        FROM kernel_workflow_instances
        WHERE instance_id = ${decoded.instanceId}
        ON CONFLICT (instance_id, wait_id) DO NOTHING
        ON CONFLICT (instance_id) WHERE state IN ('pending', 'matched') DO NOTHING
        RETURNING wait_id
      `
      const rows = yield* sql`SELECT * FROM kernel_waits
        WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}`
      if (rows.length === 0) {
        const instanceRows = yield* sql`SELECT * FROM kernel_workflow_instances
          WHERE instance_id = ${decoded.instanceId}`
        yield* Schema.decodeUnknown(InstanceRow)(instanceRows[0]).pipe(
          Effect.mapError(dataError("instance", decoded.instanceId, decoded.instanceId)),
        )
        return yield* new KernelStoreConflictError({
          record: "wait",
          key: decoded.waitId,
          instanceId: decoded.instanceId,
        })
      }
      let storedWait = yield* Schema.decodeUnknown(WaitRow)(rows[0]).pipe(
        Effect.mapError(dataError("wait", decoded.waitId, decoded.instanceId)),
      )
      if (inserted.length > 0) {
        const eventRows = yield* sql`SELECT * FROM kernel_events
          WHERE event_type = ${decoded.condition.type}
            AND event_version = ${decoded.condition.version}
            AND event_key = ${decoded.condition.key}
            AND correlation = ${decoded.condition.correlation}
            AND sequence > ${storedWait.after_sequence}
          ORDER BY sequence LIMIT 1`
        if (eventRows.length > 0) {
          const event = yield* Schema.decodeUnknown(EventRow)(eventRows[0]).pipe(
            Effect.mapError(dataError("event", decoded.waitId, decoded.instanceId)),
          )
          yield* sql`
            INSERT INTO kernel_wait_event_deliveries (
              instance_id, wait_id, event_sequence, state, delivered_at
            ) VALUES (
              ${decoded.instanceId}, ${decoded.waitId}, ${event.sequence}, 'ready',
              ${event.recorded_at}
            )
            ON CONFLICT (instance_id, wait_id) DO NOTHING
          `
          yield* sql`UPDATE kernel_waits SET state = 'matched'
            WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}
              AND state = 'pending'`
          storedWait = { ...storedWait, state: "matched" }
        }
      } else {
        if (
          storedWait.event_type !== decoded.condition.type ||
          storedWait.event_version !== decoded.condition.version ||
          storedWait.event_key !== decoded.condition.key ||
          storedWait.correlation !== decoded.condition.correlation
        ) {
          return yield* new KernelStoreConflictError({
            record: "wait",
            key: decoded.waitId,
            instanceId: decoded.instanceId,
          })
        }
      }
      const deliveryRows = yield* sql`SELECT instance_id, wait_id, event_sequence, state
        FROM kernel_wait_event_deliveries
        WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}`
      const deliveries = yield* decodeDeliveries(deliveryRows, decoded.waitId, decoded.instanceId)
      return {
        status: inserted.length > 0 ? ("registered" as const) : ("duplicate" as const),
        wait: {
          ...decoded,
          registeredAt: new Date(storedWait.registered_at),
          afterSequence: storedWait.after_sequence,
        },
        deliveries,
      }
    }).pipe(sql.withTransaction)

  const consumeDelivery: KernelEventStorePort["consumeDelivery"] = (input) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(ConsumeDeliveryInputSchema)(input).pipe(
        Effect.mapError(inputError),
      )
      const advanced = yield* sql<{ readonly event_cursor: number }>`
        UPDATE kernel_workflow_instances AS instance
        SET event_cursor = ${decoded.eventSequence}
        WHERE instance_id = ${decoded.instanceId}
          AND event_cursor = ${decoded.expectedCursor}
          AND ${decoded.eventSequence} > event_cursor
          AND EXISTS (
            SELECT 1
            FROM kernel_wait_event_deliveries AS delivery
            JOIN kernel_waits AS wait
              ON wait.instance_id = delivery.instance_id
              AND wait.wait_id = delivery.wait_id
            WHERE delivery.instance_id = instance.instance_id
              AND delivery.wait_id = ${decoded.waitId}
              AND delivery.event_sequence = ${decoded.eventSequence}
              AND delivery.state = 'ready'
              AND wait.state = 'matched'
          )
        RETURNING event_cursor
      `
      if (advanced.length > 0) {
        yield* sql`UPDATE kernel_wait_event_deliveries SET state = 'consumed'
          WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}
            AND event_sequence = ${decoded.eventSequence} AND state = 'ready'`
        yield* sql`UPDATE kernel_waits SET state = 'consumed'
          WHERE instance_id = ${decoded.instanceId} AND wait_id = ${decoded.waitId}
            AND state = 'matched'`
        return { status: "consumed" as const, eventCursor: advanced[0]!.event_cursor }
      }
      const rows = yield* sql`SELECT
          instance.event_cursor,
          delivery.event_sequence,
          wait.after_sequence,
          delivery.state AS delivery_state,
          wait.state AS wait_state
        FROM kernel_workflow_instances AS instance
        JOIN kernel_waits AS wait ON wait.instance_id = instance.instance_id
        JOIN kernel_wait_event_deliveries AS delivery
          ON delivery.instance_id = wait.instance_id AND delivery.wait_id = wait.wait_id
        WHERE instance.instance_id = ${decoded.instanceId} AND wait.wait_id = ${decoded.waitId}`
      const state = yield* Schema.decodeUnknown(ConsumeStateRow)(rows[0]).pipe(
        Effect.mapError(dataError("delivery", decoded.waitId, decoded.instanceId)),
      )
      if (
        state.event_sequence === decoded.eventSequence &&
        state.after_sequence === decoded.expectedCursor &&
        state.event_cursor >= decoded.eventSequence &&
        state.delivery_state === "consumed" &&
        state.wait_state === "consumed"
      ) {
        return { status: "duplicate" as const, eventCursor: state.event_cursor }
      }
      return yield* new KernelStoreConflictError({
        record: "wait",
        key: decoded.waitId,
        instanceId: decoded.instanceId,
      })
    }).pipe(sql.withTransaction)

  const readReadyDeliveries: KernelEventStorePort["readReadyDeliveries"] = (instanceId) =>
    Schema.decodeUnknown(Identifier)(instanceId).pipe(
      Effect.mapError(inputError),
      Effect.flatMap((decodedInstanceId) =>
        sql`SELECT
          delivery.instance_id, delivery.wait_id, delivery.event_sequence, delivery.state,
          event.source, event.source_event_id, event.event_type, event.event_version,
          event.event_key, event.correlation, event.payload_json, event.recorded_at
        FROM kernel_wait_event_deliveries AS delivery
        JOIN kernel_events AS event ON event.sequence = delivery.event_sequence
        WHERE delivery.instance_id = ${decodedInstanceId} AND delivery.state = 'ready'
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
                    key: decoded.event_key,
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
    consumeDelivery,
    createInstance,
    recordEvent,
    registerWait,
    readReadyDeliveries,
  })
})

/** Requires a SqlClient whose shared WorkflowStore bootstrap has already run migrations. */
export const KernelEventStoreLive = Layer.effect(KernelEventStore, make)

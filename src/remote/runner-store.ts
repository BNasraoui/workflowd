import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Layer } from "effect"
import type { RemoteCommand, RemoteHostMessage, RemoteResult } from "./contract"
import { decodeRemoteCommand, decodeRemoteResult } from "./codec"

export type RunnerDeliveryInput = {
  readonly deliveryId: string
  readonly data: Uint8Array
  readonly message?: RemoteHostMessage
  readonly rejection?: "malformed" | "oversized"
}

export type RunnerCommandRecord = {
  readonly commandId: string
  readonly state: "received" | "result_ready" | "result_published" | "rejected"
  readonly executionCount: number
}

export class RemoteRunnerConflict extends Data.TaggedError("RemoteRunnerConflict")<{
  readonly key: string
}> {}
export class RemoteRunnerDataError extends Data.TaggedError("RemoteRunnerDataError")<{
  readonly key: string
  readonly message: string
}> {}
export type RemoteRunnerStoreError = SqlError | RemoteRunnerConflict | RemoteRunnerDataError

export type RemoteRunnerStorePort = {
  readonly recordBatch: (
    hostId: string,
    deliveries: ReadonlyArray<RunnerDeliveryInput>,
    at: Date,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly deliveryId: string
      readonly commandId?: string
      readonly disposition: string
    }>,
    RemoteRunnerStoreError
  >
  readonly recoverReceived: () => Effect.Effect<
    ReadonlyArray<RemoteCommand>,
    RemoteRunnerStoreError
  >
  readonly executeProbe: (
    command: RemoteCommand,
    at: Date,
  ) => Effect.Effect<RemoteResult, RemoteRunnerStoreError>
  readonly pendingResults: () => Effect.Effect<ReadonlyArray<RemoteResult>, RemoteRunnerStoreError>
  readonly markResultPublished: (
    resultId: string,
    at: Date,
  ) => Effect.Effect<void, RemoteRunnerStoreError>
  readonly readCommand: (
    commandId: string,
  ) => Effect.Effect<RunnerCommandRecord | null, RemoteRunnerStoreError>
  readonly readDeliveryDispositions: () => Effect.Effect<
    ReadonlyArray<string>,
    RemoteRunnerStoreError
  >
}

export const RemoteRunnerStore = Context.GenericTag<RemoteRunnerStorePort>(
  "workflowd/remote/RemoteRunnerStore",
)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`PRAGMA busy_timeout = 5000`
  yield* sql`CREATE TABLE IF NOT EXISTS remote_runner_current (
    job_id TEXT PRIMARY KEY NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    command_id TEXT,
    disposition TEXT NOT NULL CHECK (disposition IN ('current', 'cancelled')),
    updated_at TEXT NOT NULL
  ) STRICT`
  yield* sql`CREATE TABLE IF NOT EXISTS remote_runner_inbox (
    command_id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    host_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'received', 'result_ready', 'result_published', 'rejected'
    )),
    execution_count INTEGER NOT NULL DEFAULT 0 CHECK (execution_count BETWEEN 0 AND 1),
    received_at TEXT NOT NULL
  ) STRICT`
  yield* sql`CREATE TABLE IF NOT EXISTS remote_runner_deliveries (
    delivery_id TEXT PRIMARY KEY NOT NULL,
    command_id TEXT,
    payload_sha256 TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    disposition TEXT NOT NULL CHECK (disposition IN (
      'received', 'duplicate', 'fence', 'malformed', 'oversized', 'wrong_host',
      'expired', 'stale', 'conflict'
    )),
    received_at TEXT NOT NULL
  ) STRICT`
  yield* sql`CREATE TABLE IF NOT EXISTS remote_runner_outbox (
    result_id TEXT PRIMARY KEY NOT NULL,
    command_id TEXT NOT NULL UNIQUE REFERENCES remote_runner_inbox(command_id),
    envelope_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT
  ) STRICT`

  const recordBatch: RemoteRunnerStorePort["recordBatch"] = (hostId, deliveries, at) =>
    Effect.gen(function* () {
      const outcomes: Array<{
        deliveryId: string
        commandId?: string
        disposition: string
      }> = []
      const messages = deliveries.flatMap((delivery) =>
        delivery.message === undefined ? [] : [delivery.message],
      )
      const generations = new Map<string, number>()
      for (const message of messages) {
        if (message.kind !== "fence" || message.hostId !== hostId) continue
        generations.set(
          message.jobId,
          Math.max(generations.get(message.jobId) ?? 0, message.generation),
        )
      }
      for (const [jobId, generation] of generations) {
        yield* sql`INSERT INTO remote_runner_current (
          job_id, generation, command_id, disposition, updated_at
        ) VALUES (${jobId}, ${generation}, NULL, 'current', ${at.toISOString()})
        ON CONFLICT (job_id) DO UPDATE SET generation = excluded.generation,
          command_id = CASE
            WHEN excluded.generation > remote_runner_current.generation THEN NULL
            ELSE remote_runner_current.command_id END,
          disposition = CASE
            WHEN excluded.generation > remote_runner_current.generation THEN 'current'
            ELSE remote_runner_current.disposition END,
          updated_at = excluded.updated_at
        WHERE excluded.generation > remote_runner_current.generation`
      }
      for (const delivery of deliveries) {
        const hash = createHash("sha256").update(delivery.data).digest("hex")
        const replay = yield* sql<{
          readonly disposition: string
          readonly command_id: string | null
          readonly payload_sha256: string
          readonly payload_bytes: number
        }>`
          SELECT disposition, command_id, payload_sha256, payload_bytes
          FROM remote_runner_deliveries
          WHERE delivery_id = ${delivery.deliveryId}`
        if (replay.length > 0) {
          if (
            replay[0]!.payload_sha256 !== hash ||
            replay[0]!.payload_bytes !== delivery.data.byteLength
          ) {
            yield* sql`UPDATE remote_runner_deliveries SET disposition = 'conflict'
              WHERE delivery_id = ${delivery.deliveryId}`
            outcomes.push({
              deliveryId: delivery.deliveryId,
              ...(replay[0]!.command_id === null ? {} : { commandId: replay[0]!.command_id }),
              disposition: "conflict",
            })
            continue
          }
          outcomes.push({
            deliveryId: delivery.deliveryId,
            ...(replay[0]!.command_id === null ? {} : { commandId: replay[0]!.command_id }),
            disposition: replay[0]!.disposition,
          })
          continue
        }
        if (delivery.message === undefined) {
          const disposition = delivery.rejection ?? "malformed"
          yield* sql`INSERT INTO remote_runner_deliveries (
            delivery_id, payload_sha256, payload_bytes, disposition, received_at
          ) VALUES (
            ${delivery.deliveryId}, ${hash}, ${delivery.data.byteLength},
            ${disposition}, ${at.toISOString()}
          )`
          outcomes.push({ deliveryId: delivery.deliveryId, disposition })
          continue
        }
        const message = delivery.message
        if (message.kind === "fence") {
          const fence = message
          if (fence.hostId !== hostId) {
            yield* sql`INSERT INTO remote_runner_deliveries (
              delivery_id, payload_sha256, payload_bytes, disposition, received_at
            ) VALUES (
              ${delivery.deliveryId}, ${hash}, ${delivery.data.byteLength},
              'wrong_host', ${at.toISOString()}
            )`
            outcomes.push({ deliveryId: delivery.deliveryId, disposition: "wrong_host" })
            continue
          }
          if (fence.disposition === "cancelled") {
            yield* sql`UPDATE remote_runner_current SET disposition = 'cancelled',
              command_id = NULL, updated_at = ${at.toISOString()}
              WHERE job_id = ${fence.jobId} AND generation = ${fence.generation}`
          } else {
            yield* sql`UPDATE remote_runner_current SET disposition = 'current',
              updated_at = ${at.toISOString()}
              WHERE job_id = ${fence.jobId} AND generation = ${fence.generation}`
          }
          yield* sql`INSERT INTO remote_runner_deliveries (
            delivery_id, payload_sha256, payload_bytes, disposition, received_at
          ) VALUES (
            ${delivery.deliveryId}, ${hash}, ${delivery.data.byteLength},
            'fence', ${at.toISOString()}
          )`
          outcomes.push({ deliveryId: delivery.deliveryId, disposition: "fence" })
          continue
        }
        const command = message
        let disposition = "received"
        const current = yield* sql<{
          readonly generation: number
          readonly command_id: string | null
          readonly disposition: string
        }>`SELECT generation, command_id, disposition FROM remote_runner_current
          WHERE job_id = ${command.jobId}`
        if (command.hostId !== hostId) disposition = "wrong_host"
        else if (new Date(command.expiresAt).getTime() <= at.getTime()) disposition = "expired"
        else if (
          current.length === 0 ||
          command.generation < current[0]!.generation ||
          current[0]!.disposition === "cancelled"
        ) {
          disposition = "stale"
        } else if (
          current[0]!.command_id !== null &&
          current[0]!.command_id !== command.commandId
        ) {
          disposition = "conflict"
        }
        const existing = yield* sql<{ readonly envelope_json: string }>`SELECT envelope_json
          FROM remote_runner_inbox WHERE command_id = ${command.commandId}`
        if (existing.length > 0) {
          disposition =
            existing[0]!.envelope_json === JSON.stringify(command) ? "duplicate" : "conflict"
        } else {
          yield* sql`INSERT INTO remote_runner_inbox (
            command_id, job_id, attempt, generation, host_id, envelope_json,
            state, execution_count, received_at
          ) VALUES (
            ${command.commandId}, ${command.jobId}, ${command.attempt}, ${command.generation},
            ${command.hostId}, ${JSON.stringify(command)},
            ${disposition === "received" ? "received" : "rejected"}, 0, ${at.toISOString()}
          )`
          if (disposition === "received") {
            yield* sql`UPDATE remote_runner_current SET command_id = ${command.commandId},
              updated_at = ${at.toISOString()} WHERE job_id = ${command.jobId}
              AND generation = ${command.generation} AND command_id IS NULL`
          }
        }
        yield* sql`INSERT INTO remote_runner_deliveries (
          delivery_id, command_id, payload_sha256, payload_bytes, disposition, received_at
        ) VALUES (
          ${delivery.deliveryId}, ${command.commandId}, ${hash}, ${delivery.data.byteLength},
          ${disposition}, ${at.toISOString()}
        )`
        outcomes.push({
          deliveryId: delivery.deliveryId,
          commandId: command.commandId,
          disposition,
        })
      }
      return outcomes
    }).pipe(sql.withTransaction)

  const recoverReceived: RemoteRunnerStorePort["recoverReceived"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly envelope_json: string }>`SELECT inbox.envelope_json
        FROM remote_runner_inbox AS inbox
        JOIN remote_runner_current AS current ON current.job_id = inbox.job_id
          AND current.generation = inbox.generation AND current.command_id = inbox.command_id
          AND current.disposition = 'current'
        WHERE inbox.state = 'received' ORDER BY inbox.received_at, inbox.command_id`
      return yield* Effect.forEach(rows, (row) =>
        decodeRemoteCommand(new TextEncoder().encode(row.envelope_json)).pipe(
          Effect.mapError(
            (error) => new RemoteRunnerDataError({ key: "inbox", message: error.reason }),
          ),
        ),
      )
    })

  const executeProbe: RemoteRunnerStorePort["executeProbe"] = (command, at) =>
    Effect.gen(function* () {
      const result: RemoteResult = {
        version: 1,
        resultId: `result-${command.commandId}`,
        commandId: command.commandId,
        jobId: command.jobId,
        attempt: command.attempt,
        generation: command.generation,
        hostId: command.hostId,
        kind: "probe",
        status: "succeeded",
        observedAt: at.toISOString(),
      }
      yield* sql`UPDATE remote_runner_inbox SET state = 'result_ready', execution_count = 1
        WHERE command_id = ${command.commandId} AND state = 'received'`
      yield* sql`INSERT INTO remote_runner_outbox (
        result_id, command_id, envelope_json, created_at
      ) VALUES (
        ${result.resultId}, ${command.commandId}, ${JSON.stringify(result)}, ${at.toISOString()}
      ) ON CONFLICT (command_id) DO NOTHING`
      return result
    }).pipe(sql.withTransaction)

  const pendingResults: RemoteRunnerStorePort["pendingResults"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly envelope_json: string }>`SELECT envelope_json
        FROM remote_runner_outbox WHERE published_at IS NULL ORDER BY created_at, result_id`
      return yield* Effect.forEach(rows, (row) =>
        decodeRemoteResult(new TextEncoder().encode(row.envelope_json)).pipe(
          Effect.mapError(
            (error) => new RemoteRunnerDataError({ key: "outbox", message: error.reason }),
          ),
        ),
      )
    })

  const markResultPublished: RemoteRunnerStorePort["markResultPublished"] = (resultId, at) =>
    Effect.gen(function* () {
      yield* sql`UPDATE remote_runner_outbox SET published_at = ${at.toISOString()}
        WHERE result_id = ${resultId}`
      yield* sql`UPDATE remote_runner_inbox SET state = 'result_published'
        WHERE command_id = (SELECT command_id FROM remote_runner_outbox
          WHERE result_id = ${resultId})`
    }).pipe(sql.withTransaction, Effect.asVoid)

  const readCommand: RemoteRunnerStorePort["readCommand"] = (commandId) =>
    sql<{
      readonly command_id: string
      readonly state: RunnerCommandRecord["state"]
      readonly execution_count: number
    }>`
      SELECT command_id, state, execution_count FROM remote_runner_inbox
      WHERE command_id = ${commandId}`.pipe(
      Effect.map((rows) =>
        rows.length === 0
          ? null
          : {
              commandId: rows[0]!.command_id,
              state: rows[0]!.state,
              executionCount: rows[0]!.execution_count,
            },
      ),
    )

  const readDeliveryDispositions: RemoteRunnerStorePort["readDeliveryDispositions"] = () =>
    sql<{ readonly disposition: string }>`SELECT disposition FROM remote_runner_deliveries
      ORDER BY rowid`.pipe(Effect.map((rows) => rows.map((row) => row.disposition)))

  return RemoteRunnerStore.of({
    recordBatch,
    recoverReceived,
    executeProbe,
    pendingResults,
    markResultPublished,
    readCommand,
    readDeliveryDispositions,
  })
})

export const RemoteRunnerStoreLive = Layer.effect(RemoteRunnerStore, make)

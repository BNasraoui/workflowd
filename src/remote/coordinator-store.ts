import { createHash } from "node:crypto"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  KernelJobStore,
  KernelJobStoreDataError,
  type KernelJobStoreError,
} from "../kernel/job-store"
import { RemoteProbeJobV1, type RemoteFence, type RemoteResult } from "./contract"

export type RemoteDispatch = {
  readonly commandId: string
  readonly jobId: string
  readonly attempt: number
  readonly generation: number
  readonly hostId: string
  readonly workerId: string
  readonly claimToken: string
  readonly leaseUntil: Date
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly state: "prepared" | "publishing" | "published"
}

export class RemoteCoordinatorConflict extends Data.TaggedError("RemoteCoordinatorConflict")<{
  readonly key: string
}> {}
export class RemoteCoordinatorDataError extends Data.TaggedError("RemoteCoordinatorDataError")<{
  readonly key: string
  readonly message: string
}> {}

export type RemoteCoordinatorError =
  SqlError | KernelJobStoreError | RemoteCoordinatorConflict | RemoteCoordinatorDataError

export type RemoteCoordinatorStorePort = {
  readonly prepareNext: (input: {
    readonly commandId: string
    readonly workerId: string
    readonly now: Date
    readonly leaseDurationMs: number
    readonly expiresAt: Date
  }) => Effect.Effect<RemoteDispatch | null, RemoteCoordinatorError>
  readonly pendingDispatches: () => Effect.Effect<
    ReadonlyArray<RemoteDispatch>,
    RemoteCoordinatorError
  >
  readonly markPublished: (
    commandId: string,
    at: Date,
  ) => Effect.Effect<"published" | "duplicate", RemoteCoordinatorError>
  readonly markPublishing: (
    commandId: string,
    at: Date,
  ) => Effect.Effect<"publishing" | "duplicate", RemoteCoordinatorError>
  readonly supersede: (commandId: string, at: Date) => Effect.Effect<void, RemoteCoordinatorError>
  readonly reconcileExpired: (
    at: Date,
  ) => Effect.Effect<ReadonlyArray<RemoteExpiryAction>, RemoteCoordinatorError>
  readonly pendingCancellationFences: () => Effect.Effect<
    ReadonlyArray<{ readonly commandId: string; readonly fence: RemoteFence }>,
    RemoteCoordinatorError
  >
  readonly markCancellationFencePublished: (
    commandId: string,
    at: Date,
  ) => Effect.Effect<void, RemoteCoordinatorError>
  readonly acceptResult: (
    result: RemoteResult,
    at: Date,
  ) => Effect.Effect<"accepted" | "duplicate" | "stale", RemoteCoordinatorError>
  readonly acceptDelivery: (
    deliveryId: string,
    result: RemoteResult,
    at: Date,
  ) => Effect.Effect<RemoteResultDisposition, RemoteCoordinatorError>
  readonly recordRejectedDelivery: (
    input: RejectedDelivery,
  ) => Effect.Effect<"malformed" | "oversized" | "conflict", RemoteCoordinatorError>
  readonly readInbox: () => Effect.Effect<ReadonlyArray<RemoteInboxRecord>, RemoteCoordinatorError>
}

export type RemoteResultDisposition =
  "accepted" | "duplicate" | "wrong_host" | "stale" | "expired" | "conflict"
export type RemoteExpiryAction = {
  readonly commandId: string
  readonly jobId: string
  readonly hostId: string
  readonly nextGeneration: number
  readonly publishCancellation: boolean
  readonly outcome: "retry_scheduled" | "failed"
}
export type RejectedDelivery = {
  readonly deliveryId: string
  readonly disposition: "malformed" | "oversized"
  readonly payloadSha256: string
  readonly payloadBytes: number
  readonly receivedAt: Date
}
export type RemoteInboxRecord = {
  readonly deliveryId: string
  readonly disposition: RemoteResultDisposition | "malformed" | "oversized"
}

export const RemoteCoordinatorStore = Context.Service<RemoteCoordinatorStorePort>(
  "workflowd/remote/RemoteCoordinatorStore",
)

const Timestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)), {
      message: "must be an ISO timestamp",
    }),
  ),
)
const DispatchRow = Schema.Struct({
  command_id: Schema.String,
  job_id: Schema.String,
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  generation: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  host_id: Schema.String,
  worker_id: Schema.String,
  claim_token: Schema.String,
  lease_until: Timestamp,
  issued_at: Timestamp,
  expires_at: Timestamp,
  state: Schema.Literals([
    "prepared",
    "publishing",
    "published",
    "completed",
    "superseded",
    "cancelled",
  ]),
})
type DispatchRow = typeof DispatchRow.Type

const decodeDispatch = (row: unknown, key: string) =>
  Schema.decodeUnknownEffect(DispatchRow)(row).pipe(
    Effect.mapError((error) => new RemoteCoordinatorDataError({ key, message: String(error) })),
  )

const dispatchKey = (row: unknown) =>
  typeof row === "object" &&
  row !== null &&
  "command_id" in row &&
  typeof row.command_id === "string"
    ? row.command_id
    : "unknown"

const toDispatch = (row: DispatchRow): RemoteDispatch => ({
  commandId: row.command_id,
  jobId: row.job_id,
  attempt: row.attempt,
  generation: row.generation,
  hostId: row.host_id,
  workerId: row.worker_id,
  claimToken: row.claim_token,
  leaseUntil: new Date(row.lease_until),
  issuedAt: new Date(row.issued_at),
  expiresAt: new Date(row.expires_at),
  state: row.state === "prepared" || row.state === "publishing" ? row.state : "published",
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const jobs = yield* KernelJobStore

  const prepareNext: RemoteCoordinatorStorePort["prepareNext"] = (input) =>
    Effect.gen(function* () {
      const claim = yield* jobs.claimRemoteProbe(input)
      if (claim === null) return null
      const probe = yield* Schema.decodeUnknownEffect(RemoteProbeJobV1)(claim.input).pipe(
        Effect.mapError(
          (error) =>
            new KernelJobStoreDataError({
              record: "job",
              key: claim.jobId,
              message: String(error),
            }),
        ),
      )
      const inserted = yield* sql`INSERT INTO kernel_remote_dispatches (
        command_id, job_id, attempt, generation, host_id, worker_id, claim_token,
        lease_until, state, issued_at, expires_at
      ) VALUES (
        ${input.commandId}, ${claim.jobId}, ${claim.attempt}, ${claim.attempt}, ${probe.hostId},
        ${claim.workerId}, ${claim.claimToken}, ${claim.leaseUntil.toISOString()}, 'prepared',
        ${input.now.toISOString()}, ${input.expiresAt.toISOString()}
      ) RETURNING command_id, job_id, attempt, generation, host_id, worker_id,
        claim_token, lease_until, issued_at, expires_at, state`
      return toDispatch(yield* decodeDispatch(inserted[0], input.commandId))
    }).pipe(sql.withTransaction)

  const pendingDispatches: RemoteCoordinatorStorePort["pendingDispatches"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT command_id, job_id, attempt, generation, host_id, worker_id,
        claim_token, lease_until, issued_at, expires_at, state
        FROM kernel_remote_dispatches WHERE state IN ('prepared', 'publishing')
        ORDER BY issued_at, command_id`
      return yield* Effect.forEach(rows, (row) =>
        decodeDispatch(row, dispatchKey(row)).pipe(Effect.map(toDispatch)),
      )
    })

  const markPublishing: RemoteCoordinatorStorePort["markPublishing"] = (commandId, at) =>
    Effect.gen(function* () {
      const changed = yield* sql`UPDATE kernel_remote_dispatches
        SET state = 'publishing', publish_started_at = ${at.toISOString()}
        WHERE command_id = ${commandId} AND state = 'prepared' RETURNING command_id`
      if (changed.length > 0) return "publishing" as const
      const existing = yield* sql`SELECT command_id FROM kernel_remote_dispatches
        WHERE command_id = ${commandId}
          AND state IN ('publishing', 'published', 'completed')`
      if (existing.length > 0) return "duplicate" as const
      return yield* new RemoteCoordinatorConflict({ key: commandId })
    }).pipe(sql.withTransaction)

  const markPublished: RemoteCoordinatorStorePort["markPublished"] = (commandId, at) =>
    Effect.gen(function* () {
      const changed = yield* sql`UPDATE kernel_remote_dispatches
        SET state = 'published', published_at = ${at.toISOString()}
        WHERE command_id = ${commandId} AND state = 'publishing' RETURNING command_id`
      if (changed.length > 0) return "published" as const
      const existing = yield* sql`SELECT command_id FROM kernel_remote_dispatches
        WHERE command_id = ${commandId} AND state IN ('published', 'completed')`
      if (existing.length > 0) return "duplicate" as const
      return yield* new RemoteCoordinatorConflict({ key: commandId })
    }).pipe(sql.withTransaction)

  const supersede: RemoteCoordinatorStorePort["supersede"] = (commandId, at) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT command_id, job_id, attempt, generation,
        host_id, worker_id, claim_token, lease_until, issued_at, expires_at, state
        FROM kernel_remote_dispatches WHERE command_id = ${commandId}`
      if (rows.length === 0) {
        return yield* new RemoteCoordinatorConflict({ key: commandId })
      }
      const dispatch = yield* decodeDispatch(rows[0], commandId)
      if (dispatch.state !== "published") {
        return yield* new RemoteCoordinatorConflict({ key: commandId })
      }
      const released = yield* sql`UPDATE kernel_workflow_jobs SET state = 'retry_scheduled',
        run_at = ${at.toISOString()}, lease_worker_id = NULL, claim_token = NULL,
        lease_until = NULL, failure_category = 'transient', failure_version = 1,
        failure_json = ${JSON.stringify({ message: "remote dispatch superseded" })},
        updated_at = ${at.toISOString()}
        WHERE job_id = ${dispatch.job_id} AND state = 'leased'
          AND attempt = ${dispatch.attempt} AND lease_worker_id = ${dispatch.worker_id}
          AND claim_token = ${dispatch.claim_token} AND lease_until = ${dispatch.lease_until}
        RETURNING job_id`
      if (released.length === 0) return yield* new RemoteCoordinatorConflict({ key: commandId })
      yield* sql`UPDATE kernel_remote_dispatches SET state = 'superseded'
        WHERE command_id = ${commandId} AND state = 'published'`
    }).pipe(sql.withTransaction)

  const readDelivery = (deliveryId: string) =>
    sql<{
      readonly disposition: RemoteInboxRecord["disposition"]
      readonly payload_sha256: string
      readonly payload_bytes: number
    }>`SELECT disposition, payload_sha256, payload_bytes
      FROM kernel_remote_result_inbox WHERE delivery_id = ${deliveryId}`

  const insertDelivery = (input: {
    readonly deliveryId: string
    readonly resultId?: string
    readonly commandId?: string
    readonly disposition: RemoteInboxRecord["disposition"]
    readonly payloadSha256: string
    readonly payloadBytes: number
    readonly receivedAt: Date
  }) =>
    sql`INSERT INTO kernel_remote_result_inbox (
      delivery_id, result_id, command_id, disposition, payload_sha256, payload_bytes, received_at
    ) VALUES (
      ${input.deliveryId}, ${input.resultId ?? null}, ${input.commandId ?? null},
      ${input.disposition}, ${input.payloadSha256}, ${input.payloadBytes},
      ${input.receivedAt.toISOString()}
    )`

  const replayDelivery = (
    deliveryId: string,
    replay: {
      readonly disposition: RemoteInboxRecord["disposition"]
      readonly payload_sha256: string
      readonly payload_bytes: number
    },
    payloadSha256: string,
    payloadBytes: number,
  ) =>
    Effect.gen(function* () {
      if (replay.payload_sha256 !== payloadSha256 || replay.payload_bytes !== payloadBytes) {
        yield* sql`UPDATE kernel_remote_result_inbox SET disposition = 'conflict'
          WHERE delivery_id = ${deliveryId}`
        return "conflict" as const
      }
      switch (replay.disposition) {
        case "accepted":
        case "duplicate":
        case "wrong_host":
        case "stale":
        case "expired":
        case "conflict":
          return replay.disposition
      }
      return yield* new RemoteCoordinatorConflict({ key: deliveryId })
    })

  const acceptDelivery: RemoteCoordinatorStorePort["acceptDelivery"] = (deliveryId, result, at) =>
    Effect.gen(function* () {
      const encoded = JSON.stringify(result)
      const payloadSha256 = createHash("sha256").update(encoded).digest("hex")
      const payloadBytes = new TextEncoder().encode(encoded).byteLength
      const replay = yield* readDelivery(deliveryId)
      if (replay.length > 0) {
        return yield* replayDelivery(deliveryId, replay[0]!, payloadSha256, payloadBytes)
      }
      const record = (disposition: RemoteResultDisposition) =>
        insertDelivery({
          deliveryId,
          resultId: result.resultId,
          commandId: result.commandId,
          disposition,
          payloadSha256,
          payloadBytes,
          receivedAt: at,
        }).pipe(Effect.as(disposition))
      const rows = yield* sql`SELECT command_id, job_id, attempt, generation,
        host_id, worker_id, claim_token, lease_until, issued_at, expires_at, state
        FROM kernel_remote_dispatches WHERE command_id = ${result.commandId}`
      if (rows.length === 0) return yield* record("stale")
      const dispatch = yield* decodeDispatch(rows[0], result.commandId)
      if (dispatch.host_id !== result.hostId) return yield* record("wrong_host")
      if (
        dispatch.job_id !== result.jobId ||
        dispatch.attempt !== result.attempt ||
        dispatch.generation !== result.generation
      ) {
        return yield* record("stale")
      }
      const observedAt = Date.parse(result.observedAt)
      const expiresAt = Date.parse(dispatch.expires_at)
      if (Number.isNaN(observedAt) || observedAt > expiresAt || at.getTime() > expiresAt) {
        return yield* record("expired")
      }
      const stored = yield* sql<{ readonly result_id: string; readonly result_json: string }>`
        SELECT result_id, result_json FROM kernel_workflow_job_results
        WHERE job_id = ${dispatch.job_id}`
      const resultJson = JSON.stringify({
        kind: "remote_probe",
        hostId: dispatch.host_id,
        status: result.status,
      })
      if (stored.length > 0) {
        const row = stored[0]!
        return yield* record(
          row.result_id === result.resultId && row.result_json === resultJson
            ? "duplicate"
            : "conflict",
        )
      }
      const resultOwner = yield* sql<{ readonly job_id: string }>`SELECT job_id
        FROM kernel_workflow_job_results WHERE result_id = ${result.resultId}`
      if (resultOwner.length > 0 && resultOwner[0]!.job_id !== dispatch.job_id) {
        return yield* record("conflict")
      }
      if (dispatch.state !== "publishing" && dispatch.state !== "published") {
        return yield* record("stale")
      }
      const updated = yield* sql`UPDATE kernel_workflow_jobs SET state = 'succeeded',
        lease_worker_id = NULL, claim_token = NULL, lease_until = NULL,
        updated_at = ${at.toISOString()}
        WHERE job_id = ${dispatch.job_id} AND state = 'leased'
          AND attempt = ${dispatch.attempt} AND lease_worker_id = ${dispatch.worker_id}
          AND claim_token = ${dispatch.claim_token}
          AND lease_until = ${dispatch.lease_until} RETURNING job_id`
      if (updated.length === 0) return yield* record("stale")
      yield* sql`INSERT INTO kernel_workflow_job_results (
        result_id, job_id, attempt, worker_id, claim_token, lease_until,
        result_version, result_json, completed_at
      ) VALUES (
        ${result.resultId}, ${dispatch.job_id}, ${dispatch.attempt}, ${dispatch.worker_id},
        ${dispatch.claim_token}, ${dispatch.lease_until}, 1, ${resultJson}, ${at.toISOString()}
      )`
      yield* sql`UPDATE kernel_remote_dispatches SET state = 'completed',
        completed_at = ${at.toISOString()} WHERE command_id = ${dispatch.command_id}`
      yield* insertDelivery({
        deliveryId,
        resultId: result.resultId,
        commandId: result.commandId,
        disposition: "accepted",
        payloadSha256,
        payloadBytes,
        receivedAt: at,
      })
      return "accepted" as const
    }).pipe(sql.withTransaction)

  const acceptResult: RemoteCoordinatorStorePort["acceptResult"] = (result, at) =>
    acceptDelivery(`direct:${result.resultId}`, result, at).pipe(
      Effect.map((disposition) =>
        disposition === "wrong_host" || disposition === "conflict" || disposition === "expired"
          ? "stale"
          : disposition,
      ),
    )

  const reconcileExpired: RemoteCoordinatorStorePort["reconcileExpired"] = (at) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT command_id, job_id, attempt, generation,
        host_id, worker_id, claim_token, lease_until, issued_at, expires_at, state
        FROM kernel_remote_dispatches
        WHERE state IN ('prepared', 'publishing', 'published')
          AND expires_at <= ${at.toISOString()}
        ORDER BY expires_at, command_id`
      const actions: Array<RemoteExpiryAction> = []
      for (const row of rows) {
        const dispatch = yield* decodeDispatch(row, dispatchKey(row))
        const kernelRows = yield* sql<{ readonly max_attempts: number }>`SELECT max_attempts
          FROM kernel_workflow_jobs WHERE job_id = ${dispatch.job_id}`
        if (kernelRows.length === 0) {
          return yield* new RemoteCoordinatorDataError({
            key: dispatch.command_id,
            message: "dispatch kernel job is missing",
          })
        }
        const exhausted = dispatch.attempt >= kernelRows[0]!.max_attempts
        const nextState = exhausted ? "failed" : "retry_scheduled"
        const updated = yield* sql`UPDATE kernel_workflow_jobs SET state = ${nextState},
          run_at = ${at.toISOString()}, lease_worker_id = NULL, claim_token = NULL,
          lease_until = NULL, failure_category = 'transient', failure_version = 1,
          failure_json = ${JSON.stringify({ message: "remote dispatch expired" })},
          updated_at = ${at.toISOString()}
          WHERE job_id = ${dispatch.job_id} AND state = 'leased'
            AND attempt = ${dispatch.attempt} AND lease_worker_id = ${dispatch.worker_id}
            AND claim_token = ${dispatch.claim_token} AND lease_until = ${dispatch.lease_until}
          RETURNING job_id`
        if (updated.length === 0) {
          return yield* new RemoteCoordinatorConflict({ key: dispatch.command_id })
        }
        yield* sql`UPDATE kernel_remote_dispatches
          SET state = ${exhausted ? "cancelled" : "superseded"}
          WHERE command_id = ${dispatch.command_id}`
        if (dispatch.state !== "prepared") {
          yield* sql`INSERT INTO kernel_remote_cancellation_outbox (
            command_id, job_id, generation, host_id, issued_at
          ) VALUES (
            ${dispatch.command_id}, ${dispatch.job_id}, ${dispatch.generation + 1},
            ${dispatch.host_id}, ${at.toISOString()}
          ) ON CONFLICT (command_id) DO NOTHING`
        }
        actions.push({
          commandId: dispatch.command_id,
          jobId: dispatch.job_id,
          hostId: dispatch.host_id,
          nextGeneration: dispatch.generation + 1,
          publishCancellation: dispatch.state !== "prepared",
          outcome: exhausted ? "failed" : "retry_scheduled",
        })
      }
      return actions
    }).pipe(sql.withTransaction)

  const pendingCancellationFences: RemoteCoordinatorStorePort["pendingCancellationFences"] = () =>
    sql<{
      readonly command_id: string
      readonly job_id: string
      readonly generation: number
      readonly host_id: string
      readonly issued_at: string
    }>`SELECT command_id, job_id, generation, host_id, issued_at
      FROM kernel_remote_cancellation_outbox WHERE published_at IS NULL
      ORDER BY issued_at, command_id`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          commandId: row.command_id,
          fence: {
            version: 1 as const,
            kind: "fence" as const,
            jobId: row.job_id,
            generation: row.generation,
            hostId: row.host_id,
            disposition: "cancelled" as const,
            issuedAt: row.issued_at,
          },
        })),
      ),
    )

  const markCancellationFencePublished: RemoteCoordinatorStorePort["markCancellationFencePublished"] =
    (commandId, at) =>
      sql`UPDATE kernel_remote_cancellation_outbox SET published_at = ${at.toISOString()}
        WHERE command_id = ${commandId} AND published_at IS NULL`.pipe(Effect.asVoid)

  const recordRejectedDelivery: RemoteCoordinatorStorePort["recordRejectedDelivery"] = (input) =>
    Effect.gen(function* () {
      const replay = yield* readDelivery(input.deliveryId)
      if (replay.length > 0) {
        if (
          replay[0]!.payload_sha256 !== input.payloadSha256 ||
          replay[0]!.payload_bytes !== input.payloadBytes
        ) {
          yield* sql`UPDATE kernel_remote_result_inbox SET disposition = 'conflict'
            WHERE delivery_id = ${input.deliveryId}`
          return "conflict" as const
        }
        const disposition = replay[0]!.disposition
        if (disposition === "malformed" || disposition === "oversized") return disposition
        return yield* new RemoteCoordinatorConflict({ key: input.deliveryId })
      }
      yield* insertDelivery(input)
      return input.disposition
    }).pipe(sql.withTransaction)

  const readInbox: RemoteCoordinatorStorePort["readInbox"] = () =>
    sql<{
      readonly delivery_id: string
      readonly disposition: RemoteInboxRecord["disposition"]
    }>`SELECT delivery_id, disposition FROM kernel_remote_result_inbox
      ORDER BY delivery_id`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ deliveryId: row.delivery_id, disposition: row.disposition })),
      ),
    )

  return RemoteCoordinatorStore.of({
    prepareNext,
    pendingDispatches,
    markPublished,
    markPublishing,
    supersede,
    reconcileExpired,
    pendingCancellationFences,
    markCancellationFencePublished,
    acceptResult,
    acceptDelivery,
    recordRejectedDelivery,
    readInbox,
  })
})

export const RemoteCoordinatorStoreLive = Layer.effect(RemoteCoordinatorStore, make)

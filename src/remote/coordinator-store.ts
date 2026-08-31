import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Effect, Layer, Schema } from "effect"
import {
  KernelJobStore,
  KernelJobStoreDataError,
  type KernelJobStoreError,
} from "../kernel/job-store"
import { RemoteProbeJobV1, type RemoteFence, type RemoteResult } from "./contract"
import {
  acceptRemoteDelivery,
  acceptRemoteResult,
  decodeDispatch,
  dispatchKey,
  readRemoteInbox,
  recordRejectedRemoteDelivery,
  RemoteCoordinatorConflict,
  RemoteCoordinatorDataError,
  type DispatchRow,
  type RejectedDelivery,
  type RemoteInboxRecord,
  type RemoteResultDisposition,
} from "./coordinator-result-store"

export {
  RemoteCoordinatorConflict,
  RemoteCoordinatorDataError,
  type RejectedDelivery,
  type RemoteInboxRecord,
  type RemoteResultDisposition,
} from "./coordinator-result-store"

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

export type RemoteExpiryAction = {
  readonly commandId: string
  readonly jobId: string
  readonly hostId: string
  readonly nextGeneration: number
  readonly publishCancellation: boolean
  readonly outcome: "retry_scheduled" | "failed"
}

export const RemoteCoordinatorStore = Context.Service<RemoteCoordinatorStorePort>(
  "workflowd/remote/RemoteCoordinatorStore",
)

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

  const provideSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.provideService(effect, SqlClient.SqlClient, sql)

  return RemoteCoordinatorStore.of({
    prepareNext,
    pendingDispatches,
    markPublished,
    markPublishing,
    supersede,
    reconcileExpired,
    pendingCancellationFences,
    markCancellationFencePublished,
    acceptResult: (result, at) => provideSql(acceptRemoteResult(result, at)),
    acceptDelivery: (deliveryId, result, at) =>
      provideSql(acceptRemoteDelivery(deliveryId, result, at)),
    recordRejectedDelivery: (input) => provideSql(recordRejectedRemoteDelivery(input)),
    readInbox: () => provideSql(readRemoteInbox()),
  })
})

export const RemoteCoordinatorStoreLive = Layer.effect(RemoteCoordinatorStore, make)

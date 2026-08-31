import { createHash } from "node:crypto"
import { SqlClient } from "effect/unstable/sql"
import { Data, Effect, Schema } from "effect"
import type { RemoteResult } from "./contract"

/**
 * Durable acceptance of runner results and rejected deliveries: the inbox
 * dedupe, custody/expiry checks, and the transaction that completes the
 * kernel job. Extracted from the coordinator store so both files stay under
 * the size gate; the coordinator store re-exports the shared shapes, so
 * external imports are unchanged.
 */
export class RemoteCoordinatorConflict extends Data.TaggedError("RemoteCoordinatorConflict")<{
  readonly key: string
}> {}
export class RemoteCoordinatorDataError extends Data.TaggedError("RemoteCoordinatorDataError")<{
  readonly key: string
  readonly message: string
}> {}

export type RemoteResultDisposition =
  "accepted" | "duplicate" | "wrong_host" | "stale" | "expired" | "conflict"
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

const Timestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)), {
      message: "must be an ISO timestamp",
    }),
  ),
)
export const DispatchRow = Schema.Struct({
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
export type DispatchRow = typeof DispatchRow.Type

export const decodeDispatch = (row: unknown, key: string) =>
  Schema.decodeUnknownEffect(DispatchRow)(row).pipe(
    Effect.mapError((error) => new RemoteCoordinatorDataError({ key, message: String(error) })),
  )

export const dispatchKey = (row: unknown) =>
  typeof row === "object" &&
  row !== null &&
  "command_id" in row &&
  typeof row.command_id === "string"
    ? row.command_id
    : "unknown"

const readDelivery = (sql: SqlClient.SqlClient, deliveryId: string) =>
  sql<{
    readonly disposition: RemoteInboxRecord["disposition"]
    readonly payload_sha256: string
    readonly payload_bytes: number
  }>`SELECT disposition, payload_sha256, payload_bytes
    FROM kernel_remote_result_inbox WHERE delivery_id = ${deliveryId}`

const insertDelivery = (
  sql: SqlClient.SqlClient,
  input: {
    readonly deliveryId: string
    readonly resultId?: string
    readonly commandId?: string
    readonly disposition: RemoteInboxRecord["disposition"]
    readonly payloadSha256: string
    readonly payloadBytes: number
    readonly receivedAt: Date
  },
) =>
  sql`INSERT INTO kernel_remote_result_inbox (
    delivery_id, result_id, command_id, disposition, payload_sha256, payload_bytes, received_at
  ) VALUES (
    ${input.deliveryId}, ${input.resultId ?? null}, ${input.commandId ?? null},
    ${input.disposition}, ${input.payloadSha256}, ${input.payloadBytes},
    ${input.receivedAt.toISOString()}
  )`

const replayDelivery = (
  sql: SqlClient.SqlClient,
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

/** The canonical stored result document for a job, by kind. Same JSON the
 * daemon observers read back, so it doubles as the duplicate/conflict key. */
const storedResultJson = (result: RemoteResult, hostId: string): string =>
  JSON.stringify(
    result.kind === "claude_resume"
      ? {
          kind: "claude_resume",
          hostId,
          status: result.status,
          ...(result.output === undefined ? {} : { output: result.output }),
          ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
        }
      : { kind: "remote_probe", hostId, status: result.status },
  )

/** Classifies a result against its dispatch row: either a rejection
 * disposition or "accept". Flat guards; the caller does the acceptance
 * writes. `sql` runs inside the caller's transaction. */
const classifyRemoteDelivery = (
  sql: SqlClient.SqlClient,
  dispatch: DispatchRow,
  result: RemoteResult,
  resultJson: string,
  at: Date,
) =>
  Effect.gen(function* () {
    const verdict = (d: RemoteResultDisposition | "accept") => d
    if (dispatch.host_id !== result.hostId) return verdict("wrong_host")
    if (
      dispatch.job_id !== result.jobId ||
      dispatch.attempt !== result.attempt ||
      dispatch.generation !== result.generation
    ) {
      return verdict("stale")
    }
    const observedAt = Date.parse(result.observedAt)
    const expiresAt = Date.parse(dispatch.expires_at)
    if (Number.isNaN(observedAt) || observedAt > expiresAt || at.getTime() > expiresAt) {
      return verdict("expired")
    }
    const stored = yield* sql<{ readonly result_id: string; readonly result_json: string }>`
      SELECT result_id, result_json FROM kernel_workflow_job_results
      WHERE job_id = ${dispatch.job_id}`
    if (stored.length > 0) {
      const row = stored[0]!
      const exact = row.result_id === result.resultId && row.result_json === resultJson
      return verdict(exact ? "duplicate" : "conflict")
    }
    const resultOwner = yield* sql<{ readonly job_id: string }>`SELECT job_id
      FROM kernel_workflow_job_results WHERE result_id = ${result.resultId}`
    if (resultOwner.length > 0 && resultOwner[0]!.job_id !== dispatch.job_id)
      return verdict("conflict")
    if (dispatch.state !== "publishing" && dispatch.state !== "published") return verdict("stale")
    return verdict("accept")
  })

export const acceptRemoteDelivery = (deliveryId: string, result: RemoteResult, at: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* Effect.gen(function* () {
      const encoded = JSON.stringify(result)
      const payloadSha256 = createHash("sha256").update(encoded).digest("hex")
      const payloadBytes = new TextEncoder().encode(encoded).byteLength
      const replay = yield* readDelivery(sql, deliveryId)
      if (replay.length > 0) {
        return yield* replayDelivery(sql, deliveryId, replay[0]!, payloadSha256, payloadBytes)
      }
      const record = (disposition: RemoteResultDisposition) =>
        insertDelivery(sql, {
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
      const resultJson = storedResultJson(result, dispatch.host_id)
      const classification = yield* classifyRemoteDelivery(sql, dispatch, result, resultJson, at)
      if (classification !== "accept") return yield* record(classification)
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
      yield* insertDelivery(sql, {
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
  })

export const acceptRemoteResult = (result: RemoteResult, at: Date) =>
  acceptRemoteDelivery(`direct:${result.resultId}`, result, at).pipe(
    Effect.map((disposition) =>
      disposition === "wrong_host" || disposition === "conflict" || disposition === "expired"
        ? "stale"
        : disposition,
    ),
  )

export const recordRejectedRemoteDelivery = (input: RejectedDelivery) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* Effect.gen(function* () {
      const replay = yield* readDelivery(sql, input.deliveryId)
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
      yield* insertDelivery(sql, input)
      return input.disposition
    }).pipe(sql.withTransaction)
  })

export const readRemoteInbox = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly delivery_id: string
      readonly disposition: RemoteInboxRecord["disposition"]
    }>`SELECT delivery_id, disposition FROM kernel_remote_result_inbox
      ORDER BY delivery_id`
    return rows.map((row) => ({ deliveryId: row.delivery_id, disposition: row.disposition }))
  })

import { SqlClient } from "effect/unstable/sql"
import { Context, Effect, Layer, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { KernelJobStore, type KernelJobStoreError } from "../kernel/job-store"
import type { JsonValue } from "../json"

const Timestamp = Schema.String
const NullableTimestamp = Schema.NullOr(Timestamp)

const RecentJobRow = Schema.Struct({
  job_id: Schema.String,
  instance_id: Schema.String,
  state: Schema.String,
  attempt: Schema.Int,
  max_attempts: Schema.Int,
  run_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
})

const HostDispatchRow = Schema.Struct({
  host_id: Schema.String,
  dispatch_count: Schema.Int,
  pending_count: Schema.Int,
  last_issued_at: NullableTimestamp,
  last_published_at: NullableTimestamp,
  last_completed_at: NullableTimestamp,
  last_state: Schema.NullOr(Schema.String),
})

export type JobStatusView = {
  readonly jobId: string
  readonly state: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly runAt: string
  readonly result: { readonly completedAt: string; readonly result: JsonValue } | null
}

export type RecentJobView = {
  readonly jobId: string
  readonly instanceId: string
  readonly state: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly runAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type HostHealthView = {
  readonly hostId: string
  readonly dispatchCount: number
  readonly pendingDispatches: number
  readonly lastIssuedAt: string | null
  readonly lastPublishedAt: string | null
  readonly lastResultAt: string | null
  readonly lastDispatchState: string | null
  readonly consumerLiveness: "responding" | "pending-work" | "no-evidence"
}

export type McpQueriesError = SqlError | KernelJobStoreError | Schema.SchemaError

export type McpQueriesPort = {
  readonly jobStatus: (jobId: string) => Effect.Effect<JobStatusView | null, McpQueriesError>
  readonly listRecentJobs: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<RecentJobView>, McpQueriesError>
  readonly hostHealth: () => Effect.Effect<ReadonlyArray<HostHealthView>, McpQueriesError>
}

export const McpQueries = Context.Service<McpQueriesPort>("workflowd/mcp/McpQueries")

export const MAX_RECENT_JOBS = 100

/**
 * Liveness is derived from durable dispatch rows only: a host whose most
 * recent dispatch completed is "responding"; one with published-but-open
 * dispatches has "pending-work"; anything else offers "no-evidence".
 */
const liveness = (row: typeof HostDispatchRow.Type): HostHealthView["consumerLiveness"] => {
  if (row.last_state === "completed") return "responding"
  if (row.pending_count > 0) return "pending-work"
  return row.last_completed_at === null ? "no-evidence" : "responding"
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const jobs = yield* KernelJobStore

  const jobStatus: McpQueriesPort["jobStatus"] = (jobId) =>
    Effect.gen(function* () {
      const job = yield* jobs.readJob(jobId)
      if (job === null) return null
      const result = yield* jobs.readResult(jobId)
      return {
        jobId: job.jobId,
        state: job.state,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        runAt: job.runAt.toISOString(),
        result:
          result === null
            ? null
            : { completedAt: result.completedAt.toISOString(), result: result.result },
      }
    })

  const listRecentJobs: McpQueriesPort["listRecentJobs"] = (limit) =>
    Effect.gen(function* () {
      const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_JOBS)
      const rows = yield* sql`SELECT job_id, instance_id, state, attempt, max_attempts,
        run_at, created_at, updated_at FROM kernel_workflow_jobs
        ORDER BY updated_at DESC, job_id LIMIT ${bounded}`
      const decoded = yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(RecentJobRow)(row),
      )
      return decoded.map((row) => ({
        jobId: row.job_id,
        instanceId: row.instance_id,
        state: row.state,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        runAt: row.run_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    })

  const hostHealth: McpQueriesPort["hostHealth"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT host_id,
          COUNT(*) AS dispatch_count,
          SUM(CASE WHEN state IN ('prepared', 'publishing', 'published') THEN 1 ELSE 0 END)
            AS pending_count,
          MAX(issued_at) AS last_issued_at,
          MAX(published_at) AS last_published_at,
          MAX(completed_at) AS last_completed_at,
          (SELECT state FROM kernel_remote_dispatches AS latest
            WHERE latest.host_id = kernel_remote_dispatches.host_id
            ORDER BY issued_at DESC, command_id DESC LIMIT 1) AS last_state
        FROM kernel_remote_dispatches GROUP BY host_id ORDER BY host_id`
      const decoded = yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(HostDispatchRow)(row),
      )
      return decoded.map((row) => ({
        hostId: row.host_id,
        dispatchCount: row.dispatch_count,
        pendingDispatches: row.pending_count,
        lastIssuedAt: row.last_issued_at,
        lastPublishedAt: row.last_published_at,
        lastResultAt: row.last_completed_at,
        lastDispatchState: row.last_state,
        consumerLiveness: liveness(row),
      }))
    })

  return McpQueries.of({ jobStatus, listRecentJobs, hostHealth })
})

export const McpQueriesLive = Layer.effect(McpQueries, make)

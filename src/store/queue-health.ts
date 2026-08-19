import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect } from "effect"
import type { WorkState } from "../domain/work-state"
import { operatorRetryableWorkStates, terminalFailureWorkStates } from "../domain/work-state"
import { makeCurrentnessPolicy } from "./currentness"
import { durableWorkQueues, makeWorkStatePolicy, type DurableWorkQueue } from "./work-state"

/**
 * Terminal queue failures, projected for an operator.
 *
 * A `failed` or `data_error` row owes an outcome it will never produce: nothing
 * in the runtime makes it claimable again. The controller keeps serving while
 * these accumulate, so they have to be counted somewhere an operator can look,
 * and the ones that can safely go back on a queue have to be told apart from
 * the ones that cannot.
 *
 * This module answers three questions and nothing else: how much terminally
 * failed work exists, what it is, and whether a given record may be requeued.
 * It never decides readiness — `src/operational-status.ts` does that — and it
 * never touches the QRSPI kernel queues, which run their own lifecycle.
 */

/** Why a terminally failed record can or cannot go back on its queue. */
export type FailedWorkEligibility =
  "eligible" | "quarantined" | "superseded" | "agent_session_pending"

export type FailedWorkRecord = {
  readonly id: number
  readonly state: WorkState
  readonly attempts: number
  readonly maxAttempts: number
  readonly repositoryFullName: string
  readonly pullRequestNumber: number
  readonly lastError: string | null
  readonly failedAt: string
  readonly eligibility: FailedWorkEligibility
}

export type QueueFailureCount = {
  readonly queue: DurableWorkQueue
  readonly failed: number
  readonly quarantined: number
  readonly oldestFailureAt: string | null
}

export type TerminalFailureSummary = {
  readonly queues: ReadonlyArray<QueueFailureCount>
  readonly agentSessionsAwaitingOperator: number
}

export type RequeueFailedWorkInput = {
  readonly queue: DurableWorkQueue
  readonly id: number
  readonly now: Date
}

export type ListFailedWorkInput = {
  readonly queue: DurableWorkQueue
  readonly limit: number
}

export type RequeueDisposition = "requeued" | "not_found" | "not_failed" | FailedWorkEligibility

const isTerminalFailure = (state: WorkState) =>
  terminalFailureWorkStates.some((terminal) => terminal === state)

export function makeQueueHealthOperations(sql: SqlClient) {
  const workState = makeWorkStatePolicy(sql)
  const currentness = makeCurrentnessPolicy(sql)

  /**
   * Eligibility asks the same fencing question the claim query asks, so a
   * record reported eligible is one a worker will pick up after the requeue.
   * Commands and Reconciliations answer an observation that already happened
   * and are never superseded, so for them only quarantine disqualifies.
   */
  const eligibility = (queue: DurableWorkQueue) => {
    switch (queue) {
      case "jobs":
        return sql`CASE
          WHEN candidate.state = 'data_error' THEN 'quarantined'
          WHEN NOT (${currentness.jobFencing}) THEN 'superseded'
          WHEN NOT (${currentness.noActiveAgentSession}) THEN 'agent_session_pending'
          ELSE 'eligible'
        END`
      case "publications":
        return sql`CASE
          WHEN candidate.state = 'data_error' THEN 'quarantined'
          WHEN NOT (${currentness.publicationFencing}) THEN 'superseded'
          ELSE 'eligible'
        END`
      case "commands":
      case "reconciliations":
        return sql`CASE
          WHEN candidate.state = 'data_error' THEN 'quarantined'
          ELSE 'eligible'
        END`
    }
  }

  /** A requeued job must also lose the cancellation its supersession asked for. */
  const clearCancellation = (queue: DurableWorkQueue) =>
    queue === "jobs" ? sql.literal("cancel_requested = FALSE,") : sql.literal("")

  const countQueueFailures = (queue: DurableWorkQueue) =>
    sql<{
      readonly failed: number
      readonly quarantined: number
      readonly oldest_failure_at: string | null
    }>`
      SELECT
        COUNT(*) FILTER (WHERE state = 'failed') AS failed,
        COUNT(*) FILTER (WHERE state = 'data_error') AS quarantined,
        MIN(updated_at) AS oldest_failure_at
      FROM ${sql(queue)}
      WHERE ${workState.stateIn(terminalFailureWorkStates)}
    `.pipe(
      Effect.map((rows) => ({
        queue,
        failed: rows[0]?.failed ?? 0,
        quarantined: rows[0]?.quarantined ?? 0,
        oldestFailureAt: rows[0]?.oldest_failure_at ?? null,
      })),
    )

  const summarizeTerminalFailures = () =>
    Effect.gen(function* () {
      const queues = yield* Effect.forEach(durableWorkQueues, countQueueFailures)
      const sessions = yield* sql<{ readonly awaiting_operator: number }>`
        SELECT COUNT(*) AS awaiting_operator
        FROM agent_executions
        WHERE cleanup_disposition = 'operator_required'
      `
      return {
        queues,
        agentSessionsAwaitingOperator: sessions[0]?.awaiting_operator ?? 0,
      }
    })

  const listFailedWork = (input: ListFailedWorkInput) =>
    sql<{
      readonly id: number
      readonly state: WorkState
      readonly attempts: number
      readonly max_attempts: number
      readonly repository_full_name: string
      readonly pull_request_number: number
      readonly last_error: string | null
      readonly failed_at: string
      readonly eligibility: FailedWorkEligibility
    }>`
      SELECT
        candidate.id AS id,
        candidate.state AS state,
        candidate.attempts AS attempts,
        candidate.max_attempts AS max_attempts,
        candidate.repository_full_name AS repository_full_name,
        candidate.pull_request_number AS pull_request_number,
        candidate.last_error AS last_error,
        candidate.updated_at AS failed_at,
        ${eligibility(input.queue)} AS eligibility
      FROM ${sql(input.queue)} AS candidate
      WHERE ${workState.stateIn(terminalFailureWorkStates, "candidate")}
      ORDER BY candidate.updated_at ASC, candidate.id ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          id: row.id,
          state: row.state,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          repositoryFullName: row.repository_full_name,
          pullRequestNumber: row.pull_request_number,
          lastError: row.last_error,
          failedAt: row.failed_at,
          eligibility: row.eligibility,
        })),
      ),
    )

  const requeueFailedWork = (input: RequeueFailedWorkInput) =>
    Effect.gen(function* () {
      const timestamp = input.now.toISOString()
      const candidates = yield* sql<{
        readonly state: WorkState
        readonly eligibility: FailedWorkEligibility
      }>`
        SELECT candidate.state AS state, ${eligibility(input.queue)} AS eligibility
        FROM ${sql(input.queue)} AS candidate
        WHERE candidate.id = ${input.id}
      `
      const candidate = candidates[0]
      if (candidate === undefined) return "not_found" as const
      if (!isTerminalFailure(candidate.state)) return "not_failed" as const
      if (candidate.eligibility !== "eligible") return candidate.eligibility

      yield* sql`
        UPDATE ${sql(input.queue)}
        SET
          ${clearCancellation(input.queue)}
          state = 'ready',
          attempts = 0,
          run_at = ${timestamp},
          ${workState.releaseLease},
          last_error = NULL,
          updated_at = ${timestamp}
        WHERE id = ${input.id}
        AND ${workState.stateIn(operatorRetryableWorkStates)}
      `
      return "requeued" as const
    }).pipe(sql.withTransaction)

  return { summarizeTerminalFailures, listFailedWork, requeueFailedWork }
}

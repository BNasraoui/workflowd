import { Effect } from "effect"
import { WorkflowStore, type WorkflowStorePort } from "./store/contracts"
import type { TerminalFailureSummary } from "./store/queue-health"
import { WorkerHealth, type WorkerHealthPort, type WorkerLaneHealth } from "./worker-health"

/**
 * Readiness, as distinct from liveness.
 *
 * Liveness is the listener answering at all, and `/health` says only that.
 * Readiness is the narrower claim that this controller can do the work it
 * exists to do: its durable store answers, and every supervised worker lane is
 * running iterations rather than failing them. Both questions are answered from
 * local state — readiness never calls GitHub, so a GitHub outage cannot make a
 * healthy controller look broken, and a readiness poll cannot spend the
 * installation's rate limit.
 *
 * Terminal queue failures are reported here but deliberately do not decide
 * readiness. Failed work is a backlog for a person, not a reason to restart or
 * depool the process: no restart clears it, and the remedy is the operator
 * retry workflow in `scripts/failed-work.ts`.
 *
 * The response carries counts and statuses only. It is reachable from wherever
 * the listener is published, so no error text from a failed job, publication,
 * command or reconciliation belongs in it; that detail stays in the local
 * operator command and the journal.
 */
export type OperationalStatus = {
  readonly status: "ready" | "not_ready"
  readonly store: "ok" | "unavailable"
  readonly workers: ReadonlyArray<WorkerLaneHealth>
  readonly terminalFailures: TerminalFailureSummary | null
}

export function operationalStatus(): Effect.Effect<
  OperationalStatus,
  never,
  WorkflowStorePort | WorkerHealthPort
> {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const health = yield* WorkerHealth
    const workers = yield* health.report
    // The one query answers both questions readiness asks of the store: that it
    // is reachable, and how much terminally failed work has piled up in it.
    const terminalFailures = yield* store
      .summarizeTerminalFailures()
      .pipe(
        Effect.catchAll((error) =>
          Effect.logError("Durable store is unavailable for readiness", error).pipe(
            Effect.as(null),
          ),
        ),
      )
    const workersReady = workers.every((lane) => lane.status === "ok")
    return {
      status: terminalFailures !== null && workersReady ? "ready" : "not_ready",
      store: terminalFailures === null ? "unavailable" : "ok",
      workers,
      terminalFailures,
    }
  })
}

import { join } from "node:path"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { AgentRunConfig, AppConfig } from "../config"
import { AgentRunDispatchSettings } from "../config-reload"
import { removeAgentRunWorktree } from "./agent-run-worktrees"
import { KernelSessionStore, type CleanupClaim } from "./session-store"

/**
 * Removes the worktrees of finished agent runs once their retention has
 * passed, through the kernel's durable cleanup requests:
 *
 * - only runs whose process is confirmed stopped (`completed`, `failed`,
 *   `cancelled`) count as ended; `operator_required` may still own a live
 *   process, so it keeps its worktree;
 * - retention runs from the latest change to the run, its sessions and its
 *   resource, and a worktree whose session is the parent of an open
 *   `wait_for_agent` is left alone;
 * - each iteration requests and executes at most `batchSize` cleanups, so
 *   runs that ended while the daemon was down are caught up after a restart
 *   in bounded batches;
 * - a claim re-checks that its runs ended and that its directory is
 *   `<worktreeRoot>/agent-runs/<id>` before touching anything;
 * - a dirty or locked worktree ends the request in `operator_required`,
 *   logged and shown by `list_agent_runs`; it is never deleted, and it is
 *   checked again after `RECHECK_RETAINED_MS` so an operator's fix is seen;
 * - Git failures retry a bounded number of times, and an expired lease is
 *   reclaimed after a crash.
 */
export type AgentRunWorktreeJanitorOptions = {
  readonly owningHostId: string
  readonly worktreeRoot: string
  readonly repositories: ReadonlyArray<{ readonly name: string; readonly directory: string }>
  readonly retentionMs: number
  /** The most cleanups one iteration requests, and the most it executes. */
  readonly batchSize: number
  readonly now: () => Date
}

export type AgentRunWorktreeJanitor = {
  readonly iteration: Effect.Effect<"worked" | "idle", never>
}

export const AgentRunWorktreeJanitor = Context.Service<AgentRunWorktreeJanitor>(
  "workflowd/kernel/AgentRunWorktreeJanitor",
)

/** Run states whose process is confirmed stopped. */
const ENDED_STATES = ["completed", "cancelled", "failed"] as const
export const AGENT_RUN_WORKTREE_CLEANUP_PREFIX = "agent-run-worktree-"
export const AGENT_RUN_WORKTREE_BATCH_SIZE = 20
/** How long the worker pauses after a batch before it looks for more work. */
export const AGENT_RUN_WORKTREE_BATCH_PAUSE_MS = 60_000
const RECHECK_RETAINED_MS = 6 * 60 * 60_000
const LEASE_DURATION_MS = 5 * 60_000
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 10 * 60_000
const WORKER_ID = `${process.pid}:agent-run-worktree-janitor`

type Decision = {
  readonly disposition: "completed" | "missing" | "retry" | "operator_required"
  readonly runId: string | null
  readonly directory: string | null
  readonly detail: string
}

const iteration = (options: AgentRunWorktreeJanitorOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const sessions = yield* KernelSessionStore
    const settings = yield* Effect.serviceOption(AgentRunDispatchSettings)
    const now = options.now()
    const runsRoot = join(options.worktreeRoot, "agent-runs")
    const prefix = `${runsRoot}/`

    const retained = yield* sql<{ readonly cleanup_id: string }>`SELECT cleanup_id
      FROM kernel_cleanup_requests WHERE owning_host_id = ${options.owningHostId}
        AND substr(cleanup_id, 1, ${AGENT_RUN_WORKTREE_CLEANUP_PREFIX.length}) = ${AGENT_RUN_WORKTREE_CLEANUP_PREFIX}
        AND state = 'operator_required'
        AND updated_at <= ${new Date(now.getTime() - RECHECK_RETAINED_MS).toISOString()}
      ORDER BY updated_at, cleanup_id LIMIT ${options.batchSize}`
    for (const request of retained)
      yield* sessions.requeueCleanup({
        cleanupId: request.cleanup_id,
        owningHostId: options.owningHostId,
        maxAttempts: MAX_ATTEMPTS,
        runAt: now,
      })

    // Selection and request share a transaction so no wait or resume can be
    // registered on the resource in between.
    const requested = yield* Effect.gen(function* () {
      const due = yield* sql<{
        readonly run_id: string
        readonly state: string
        readonly resource_id: string
      }>`SELECT run_id, state, resource_id FROM (
        SELECT run.run_id, run.state, resource.resource_id, max(run.updated_at, resource.updated_at,
          COALESCE((SELECT max(session.updated_at) FROM kernel_sessions AS session
            WHERE session.resource_id = resource.resource_id), run.updated_at)) AS last_activity
        FROM kernel_agent_runs AS run
        JOIN kernel_working_resources AS resource ON resource.absolute_path = run.directory
          AND resource.owning_host_id = ${options.owningHostId}
        WHERE run.state IN ${sql.in(ENDED_STATES)}
          AND substr(run.directory, 1, ${prefix.length}) = ${prefix}
          AND resource.kind = 'worktree' AND resource.state = 'reserved'
          AND NOT EXISTS (SELECT 1 FROM kernel_cleanup_requests AS cleanup
            WHERE cleanup.resource_id = resource.resource_id)
          AND NOT EXISTS (SELECT 1 FROM kernel_agent_runs AS other
            WHERE other.directory = run.directory AND other.state NOT IN ${sql.in(ENDED_STATES)})
          AND NOT EXISTS (SELECT 1 FROM kernel_resume_requests AS request
            JOIN kernel_sessions AS session ON session.session_id = request.session_id
            WHERE session.resource_id = resource.resource_id
              AND request.state IN ('ready', 'leased', 'sent', 'observation_required'))
          AND NOT EXISTS (SELECT 1 FROM kernel_sessions AS session
            JOIN kernel_workflow_instances AS instance
              ON instance.workflow_type = 'wait_for_agent'
              AND json_extract(instance.payload_json, '$.parentSessionId') = session.session_id
            WHERE session.resource_id = resource.resource_id AND (
              EXISTS (SELECT 1 FROM kernel_waits AS wait WHERE wait.instance_id = instance.instance_id
                AND wait.state IN ('pending', 'matched'))
              OR EXISTS (SELECT 1 FROM kernel_workflow_jobs AS job
                WHERE job.instance_id = instance.instance_id
                  AND job.state IN ('ready', 'leased', 'retry_scheduled'))))
      ) WHERE last_activity <= ${new Date(now.getTime() - options.retentionMs).toISOString()}
      ORDER BY last_activity, run_id LIMIT ${options.batchSize}`
      for (const run of due)
        yield* sessions.requestCleanup({
          cleanupId: `${AGENT_RUN_WORKTREE_CLEANUP_PREFIX}${run.run_id}`,
          resourceId: run.resource_id,
          owningHostId: options.owningHostId,
          reason: `agent run ${run.run_id} ended ${run.state}; worktree retention elapsed`,
          maxAttempts: MAX_ATTEMPTS,
          runAt: now,
          createdAt: now,
        })
      return due.length
    }).pipe(sql.withTransaction)

    const decide = Effect.fnUntraced(function* (claim: CleanupClaim) {
      const refuse = (
        detail: string,
        runId: string | null = null,
        directory: string | null = null,
      ) => ({ disposition: "operator_required", runId, directory, detail }) satisfies Decision
      const resource = yield* sessions.readResource(claim.resourceId)
      const directory = typeof resource?.absolute_path === "string" ? resource.absolute_path : null
      if (
        directory === null ||
        resource?.kind !== "worktree" ||
        !directory.startsWith(prefix) ||
        directory.slice(prefix.length).includes("/")
      )
        return refuse("resource is not an agent-run worktree", null, directory)
      const runs = yield* sql<{
        readonly run_id: string
        readonly state: string
        readonly repository: string
      }>`SELECT run_id, state, repository FROM kernel_agent_runs WHERE directory = ${directory}
        ORDER BY created_at, run_id`
      const run = runs[0]
      if (run === undefined) return refuse("no agent run owns this worktree", null, directory)
      const active = runs.find(
        (candidate) => !(ENDED_STATES as ReadonlyArray<string>).includes(candidate.state),
      )
      if (active !== undefined)
        return refuse(`agent run ${active.run_id} is ${active.state}`, active.run_id, directory)
      const repositories = Option.match(settings, {
        onNone: () => options.repositories,
        onSome: (current) => current.current()?.repositories ?? options.repositories,
      })
      const repository = repositories.find((candidate) => candidate.name === run.repository)
      if (repository === undefined)
        return refuse(`repository ${run.repository} is not configured`, run.run_id, directory)
      if (repository.directory === directory)
        return refuse("directory is the repository checkout", run.run_id, directory)
      const removal = yield* removeAgentRunWorktree({
        repository: repository.directory,
        directory,
      }).pipe(Effect.result)
      if (removal._tag === "Failure")
        return {
          disposition: "retry",
          runId: run.run_id,
          directory,
          detail: `${removal.failure.operation} failed: ${removal.failure.cause.message}`,
        } satisfies Decision
      if (removal.success.outcome === "retained")
        return refuse(removal.success.detail, run.run_id, directory)
      return {
        disposition: removal.success.outcome === "removed" ? "completed" : "missing",
        runId: run.run_id,
        directory,
        detail: removal.success.outcome === "removed" ? "worktree removed" : "worktree was absent",
      } satisfies Decision
    })

    const execute = Effect.fnUntraced(function* (claim: CleanupClaim) {
      const decision = yield* decide(claim)
      const finishedAt = options.now()
      yield* sessions.completeCleanup({
        cleanupId: claim.cleanupId,
        attempt: claim.attempt,
        owningHostId: claim.owningHostId,
        workerId: claim.workerId,
        claimToken: claim.claimToken,
        expectedLeaseUntil: claim.leaseUntil,
        now: finishedAt,
        outcomeId: `${claim.cleanupId}-attempt-${claim.attempt}`,
        disposition: decision.disposition,
        outcomeVersion: 1,
        outcome: {
          run_id: decision.runId,
          directory: decision.directory,
          detail: decision.detail,
        },
        ...(decision.disposition === "retry"
          ? { runAt: new Date(finishedAt.getTime() + RETRY_DELAY_MS) }
          : {}),
      })
      const annotations = { runId: decision.runId, directory: decision.directory }
      if (
        decision.disposition === "operator_required" ||
        (decision.disposition === "retry" && claim.attempt >= claim.maxAttempts)
      )
        yield* Effect.logWarning(
          `Agent-run worktree retained for an operator: ${decision.detail}`,
        ).pipe(Effect.annotateLogs(annotations))
      else if (decision.disposition === "retry")
        yield* Effect.logWarning(`Agent-run worktree cleanup will retry: ${decision.detail}`).pipe(
          Effect.annotateLogs(annotations),
        )
      else
        yield* Effect.logInfo(`Agent-run worktree cleaned: ${decision.detail}`).pipe(
          Effect.annotateLogs(annotations),
        )
    })

    let executed = 0
    while (executed < options.batchSize) {
      const claim = yield* sessions.claimCleanup({
        owningHostId: options.owningHostId,
        workerId: WORKER_ID,
        now: options.now(),
        leaseDurationMs: LEASE_DURATION_MS,
        cleanupIdPrefix: AGENT_RUN_WORKTREE_CLEANUP_PREFIX,
      })
      if (claim === null) break
      yield* execute(claim)
      executed += 1
    }
    return retained.length + requested + executed === 0 ? ("idle" as const) : ("worked" as const)
  })

export const AgentRunWorktreeJanitorLive = (options: AgentRunWorktreeJanitorOptions) =>
  Layer.effect(
    AgentRunWorktreeJanitor,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* KernelSessionStore
      const settings = yield* Effect.serviceOption(AgentRunDispatchSettings)
      return {
        iteration: iteration(options).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(KernelSessionStore, sessions),
          Option.isSome(settings)
            ? Effect.provideService(AgentRunDispatchSettings, settings.value)
            : (effect) => effect,
          Effect.catchCause((cause) =>
            Effect.logError("Agent-run worktree janitor iteration failed", cause).pipe(
              Effect.as("idle" as const),
            ),
          ),
        ),
      }
    }),
  )

/** Agent-host workspaces are clones owned by the agent UID; the controller never runs Git in them. */
export const agentRunWorktreeJanitorLayer = (
  config: Pick<AppConfig, "credentialSocket" | "workspace" | "worker">,
  runs: Pick<AgentRunConfig, "repositories" | "worktreeRetentionMs">,
) =>
  config.credentialSocket === undefined
    ? AgentRunWorktreeJanitorLive({
        owningHostId: config.worker.hostId,
        worktreeRoot: config.workspace.worktreeRoot,
        repositories: runs.repositories,
        retentionMs: runs.worktreeRetentionMs,
        batchSize: AGENT_RUN_WORKTREE_BATCH_SIZE,
        now: () => new Date(),
      })
    : Layer.empty

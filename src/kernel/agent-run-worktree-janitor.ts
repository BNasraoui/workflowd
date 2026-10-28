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
 * - each iteration requests cleanup for at most one terminal run whose
 *   retention elapsed (so runs that ended while the daemon was down are
 *   caught up after a restart), then claims and executes at most one request;
 * - a claim re-checks that its run is terminal and that its directory is
 *   `<worktreeRoot>/agent-runs/<id>` before touching anything;
 * - a dirty or locked worktree ends the request in `operator_required`,
 *   logged once and shown by `list_agent_runs`; it is never deleted;
 * - Git failures retry a bounded number of times, and an expired lease is
 *   reclaimed after a crash.
 */
export type AgentRunWorktreeJanitorOptions = {
  readonly owningHostId: string
  readonly worktreeRoot: string
  readonly repositories: ReadonlyArray<{ readonly name: string; readonly directory: string }>
  readonly retentionMs: number
  readonly now: () => Date
}

export type AgentRunWorktreeJanitor = {
  readonly iteration: Effect.Effect<"worked" | "idle", never>
}

export const AgentRunWorktreeJanitor = Context.Service<AgentRunWorktreeJanitor>(
  "workflowd/kernel/AgentRunWorktreeJanitor",
)

const TERMINAL_STATES = ["completed", "cancelled", "failed", "operator_required"] as const
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

export const runAgentRunWorktreeJanitorIteration = (options: AgentRunWorktreeJanitorOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const sessions = yield* KernelSessionStore
    const settings = yield* Effect.serviceOption(AgentRunDispatchSettings)
    const now = options.now()
    const runsRoot = join(options.worktreeRoot, "agent-runs")
    const prefix = `${runsRoot}/`

    const due = yield* sql<{
      readonly run_id: string
      readonly state: string
      readonly resource_id: string
    }>`SELECT run.run_id, run.state, resource.resource_id FROM kernel_agent_runs AS run
      JOIN kernel_working_resources AS resource ON resource.absolute_path = run.directory
        AND resource.owning_host_id = ${options.owningHostId}
      WHERE run.state IN ${sql.in(TERMINAL_STATES)}
        AND run.updated_at <= ${new Date(now.getTime() - options.retentionMs).toISOString()}
        AND substr(run.directory, 1, ${prefix.length}) = ${prefix}
        AND resource.kind = 'worktree' AND resource.state = 'reserved'
        AND NOT EXISTS (SELECT 1 FROM kernel_cleanup_requests AS cleanup
          WHERE cleanup.resource_id = resource.resource_id)
        AND NOT EXISTS (SELECT 1 FROM kernel_agent_runs AS other
          WHERE other.directory = run.directory AND other.state NOT IN ${sql.in(TERMINAL_STATES)})
        AND NOT EXISTS (SELECT 1 FROM kernel_resume_requests AS request
          JOIN kernel_sessions AS session ON session.session_id = request.session_id
          WHERE session.resource_id = resource.resource_id
            AND request.state IN ('ready', 'leased', 'sent', 'observation_required'))
      ORDER BY run.updated_at, run.run_id LIMIT 1`
    const requested = due[0]
    if (requested !== undefined) {
      yield* sessions.requestCleanup({
        cleanupId: `agent-run-worktree-${requested.run_id}`,
        resourceId: requested.resource_id,
        owningHostId: options.owningHostId,
        reason: `agent run ${requested.run_id} ended ${requested.state}; worktree retention elapsed`,
        maxAttempts: MAX_ATTEMPTS,
        runAt: now,
        createdAt: now,
      })
    }

    const claim = yield* sessions.claimCleanup({
      owningHostId: options.owningHostId,
      workerId: WORKER_ID,
      now,
      leaseDurationMs: LEASE_DURATION_MS,
    })
    if (claim === null) return requested === undefined ? ("idle" as const) : ("worked" as const)

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
        (candidate) => !(TERMINAL_STATES as ReadonlyArray<string>).includes(candidate.state),
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
    return "worked" as const
  })

export const AgentRunWorktreeJanitorLive = (options: AgentRunWorktreeJanitorOptions) =>
  Layer.effect(
    AgentRunWorktreeJanitor,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* KernelSessionStore
      const settings = yield* Effect.serviceOption(AgentRunDispatchSettings)
      return {
        iteration: runAgentRunWorktreeJanitorIteration(options).pipe(
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
        now: () => new Date(),
      })
    : Layer.empty

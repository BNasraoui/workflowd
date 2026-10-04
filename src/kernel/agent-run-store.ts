import { canonicalJson } from "./session-store-support"
import { randomBytes } from "node:crypto"
import { SqlClient } from "effect/unstable/sql"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { RequestedSelection, ResolvedSelection } from "../execution-selection"

/**
 * Durable record of one managed agent run: a dispatched child session the
 * runner spawned, verified, and now supervises. The row is the authority the
 * ingress resumes from after a crash mid-dispatch and the watchdog acts on
 * afterwards.
 *
 * States: accepted (row exists, nothing external yet) → spawning (exactly
 * one dispatching request holds the spawn; concurrent duplicates conflict
 * before any external side effect) → spawned (worktree, session and custody
 * exist, prompt sent) → verified (first generated token observed; the
 * receipt has been issued) → completed | failed | cancelled | operator_required.
 */
export type AgentRunState =
  | "accepted"
  | "spawning"
  | "spawned"
  | "verified"
  | "completed"
  | "cancelled"
  | "failed"
  | "operator_required"

const AgentRunRow = Schema.Struct({
  run_id: Schema.String,
  caller_mailbox_id: Schema.String,
  route: Schema.String,
  provider_id: Schema.String,
  model_id: Schema.String,
  executor_kind: Schema.Literals(["opencode", "codex", "claude"]),
  requested_selection: Schema.NullOr(Schema.String),
  resolved_selection: Schema.NullOr(Schema.String),
  agent: Schema.String,
  repository: Schema.String,
  base_ref: Schema.NullOr(Schema.String),
  directory: Schema.String,
  prompt: Schema.String,
  parent_session_id: Schema.NullOr(Schema.String),
  resume_prompt: Schema.NullOr(Schema.String),
  resource_id: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  native_session_id: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "accepted",
    "spawning",
    "spawned",
    "verified",
    "completed",
    "cancelled",
    "failed",
    "operator_required",
  ]),
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  max_attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  last_output_tokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  last_progress_at: Schema.NullOr(Schema.String),
  diagnostic: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

export type AgentRunRecord = {
  readonly executorKind?: "opencode" | "codex" | "claude"
  readonly requestedSelection?: RequestedSelection | null
  readonly resolvedSelection?: ResolvedSelection | null
  readonly runId: string
  readonly callerMailboxId: string
  readonly route: string
  readonly providerId: string
  readonly modelId: string
  readonly agent: string
  readonly repository: string
  readonly baseRef?: string | null
  readonly directory: string
  readonly prompt: string
  readonly parentSessionId: string | null
  readonly resumePrompt: string | null
  readonly resourceId: string | null
  readonly sessionId: string | null
  readonly nativeSessionId: string | null
  readonly state: AgentRunState
  readonly attempt: number
  readonly maxAttempts: number
  readonly lastOutputTokens: number
  readonly lastProgressAt: Date | null
  readonly diagnostic: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type AgentRunCreateInput = {
  readonly executorKind?: "opencode" | "codex" | "claude"
  readonly requestedSelection?: RequestedSelection
  readonly resolvedSelection?: ResolvedSelection
  readonly runId: string
  readonly route: string
  readonly providerId: string
  readonly modelId: string
  readonly agent: string
  readonly repository: string
  readonly baseRef?: string | null
  readonly directory: string
  readonly prompt: string
  readonly promptSha256: string
  readonly parentSessionId: string | null
  readonly resumePrompt: string | null
  readonly maxAttempts: number
  readonly createdAt: Date
}

export class AgentRunStoreConflictError extends Data.TaggedError("AgentRunStoreConflictError")<{
  readonly runId: string
  readonly detail: string
}> {}

export class AgentRunStoreDataError extends Data.TaggedError("AgentRunStoreDataError")<{
  readonly runId: string
  readonly message: string
}> {}

export type AgentRunStoreError =
  | AgentRunStoreConflictError
  | AgentRunStoreDataError
  | import("effect/unstable/sql/SqlError").SqlError

type Authority = { readonly runId: string; readonly now: Date }

/** Only pre-contract callers lack an executor kind; their old markers identify native CLIs. */
export const agentRunExecutorKind = (run: {
  readonly executorKind?: "opencode" | "codex" | "claude"
  readonly providerId: string
}): "opencode" | "codex" | "claude" =>
  run.executorKind ??
  (run.providerId === "codex-cli"
    ? "codex"
    : run.providerId === "claude-cli"
      ? "claude"
      : "opencode")

export type AgentRunStorePort = {
  readonly recordResolvedSelection: (
    input: Authority & { readonly selection: ResolvedSelection },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly create: (
    input: AgentRunCreateInput,
  ) => Effect.Effect<{ readonly status: "created" | "duplicate" }, AgentRunStoreError>
  readonly claimSpawn: (input: Authority) => Effect.Effect<void, AgentRunStoreError>
  readonly abandonLaunch: (input: Authority) => Effect.Effect<void, AgentRunStoreError>
  readonly read: (runId: string) => Effect.Effect<AgentRunRecord | null, AgentRunStoreError>
  readonly markSpawned: (
    input: Authority & {
      readonly resourceId: string
      readonly sessionId: string
      readonly nativeSessionId: string
    },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly markVerified: (
    input: Authority & { readonly outputTokens: number },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly recordProgress: (
    input: Authority & { readonly outputTokens: number },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly touch: (input: Authority) => Effect.Effect<void, AgentRunStoreError>
  readonly beginAttempt: (
    input: Authority & { readonly attempt: number; readonly diagnostic: string },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly complete: (
    input: Authority & { readonly finalMessage?: string | null },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly fail: (
    input: Authority & { readonly diagnostic: string; readonly finalMessage?: string | null },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly cancel: (
    input: Authority & { readonly diagnostic?: string },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly operatorRequired: (
    input: Authority & { readonly diagnostic: string; readonly finalMessage?: string | null },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly nextWatchable: (input: {
    readonly now: Date
    readonly staleAfterMs: number
    /** Executor kinds supervised through native process custody rather than the
     * OpenCode watchdog, including uncertain pre-verification launches. */
    readonly unsupervisedExecutorKinds: ReadonlyArray<"opencode" | "codex" | "claude">
  }) => Effect.Effect<AgentRunRecord | null, AgentRunStoreError>
  /** Metadata query for callers explicitly interested in a model provider. */
  readonly listActiveByProvider: (
    providerId: string,
    transientOnly?: boolean,
  ) => Effect.Effect<ReadonlyArray<AgentRunRecord>, AgentRunStoreError>
  /** Startup recovery classifies execution by the persisted executor kind. */
  readonly listActiveByExecutor: (
    kind: "opencode" | "codex" | "claude",
    transientOnly?: boolean,
  ) => Effect.Effect<ReadonlyArray<AgentRunRecord>, AgentRunStoreError>
}

export const AgentRunStore = Context.Service<AgentRunStorePort>("workflowd/kernel/AgentRunStore")

const toRecord = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(AgentRunRow)(row).pipe(
    Effect.mapError(
      (error) => new AgentRunStoreDataError({ runId: String(row.run_id), message: String(error) }),
    ),
    Effect.flatMap((decoded) =>
      Effect.gen(function* () {
        const requestedSelection =
          decoded.requested_selection === null
            ? null
            : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RequestedSelection))(
                decoded.requested_selection,
              )
        const resolvedSelection =
          decoded.resolved_selection === null
            ? null
            : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ResolvedSelection))(
                decoded.resolved_selection,
              )
        return {
          executorKind: decoded.executor_kind,
          requestedSelection,
          resolvedSelection,
          runId: decoded.run_id,
          callerMailboxId: decoded.caller_mailbox_id,
          route: decoded.route,
          providerId: decoded.provider_id,
          modelId: decoded.model_id,
          agent: decoded.agent,
          repository: decoded.repository,
          baseRef: decoded.base_ref,
          directory: decoded.directory,
          prompt: decoded.prompt,
          parentSessionId: decoded.parent_session_id,
          resumePrompt: decoded.resume_prompt,
          resourceId: decoded.resource_id,
          sessionId: decoded.session_id,
          nativeSessionId: decoded.native_session_id,
          state: decoded.state,
          attempt: decoded.attempt,
          maxAttempts: decoded.max_attempts,
          lastOutputTokens: decoded.last_output_tokens,
          lastProgressAt:
            decoded.last_progress_at === null ? null : new Date(decoded.last_progress_at),
          diagnostic: decoded.diagnostic,
          createdAt: new Date(decoded.created_at),
          updatedAt: new Date(decoded.updated_at),
        } satisfies AgentRunRecord
      }).pipe(
        Effect.mapError(
          (error) =>
            new AgentRunStoreDataError({ runId: String(row.run_id), message: String(error) }),
        ),
      ),
    ),
  )

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const readRow = (runId: string) =>
    sql`SELECT * FROM kernel_agent_runs WHERE run_id = ${runId}`.pipe(
      Effect.flatMap((rows) => (rows.length === 0 ? Effect.succeed(null) : toRecord(rows[0]!))),
    )

  const conflict = (runId: string, detail: string) =>
    new AgentRunStoreConflictError({ runId, detail })

  /**
   * Guarded transition: the UPDATE names the states it may leave from, and
   * zero updated rows means the run is not in one of them — a conflict, not
   * a silent no-op.
   */
  const transition = (
    runId: string,
    detail: string,
    update: Effect.Effect<ReadonlyArray<unknown>, AgentRunStoreError>,
  ) =>
    update.pipe(
      Effect.flatMap((rows) =>
        rows.length > 0 ? Effect.void : Effect.fail(conflict(runId, detail)),
      ),
    )

  const create: AgentRunStorePort["create"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* readRow(input.runId)
      if (existing !== null) {
        // Pre-migration rows carry no new selection document. A plain alias
        // replay still has to match every original provider/model field below.
        const legacyAlias =
          existing.requestedSelection == null &&
          input.requestedSelection?.route !== undefined &&
          input.requestedSelection.model === undefined &&
          input.requestedSelection.thinking === undefined
        const exact =
          existing.route === input.route &&
          existing.providerId === input.providerId &&
          existing.modelId === input.modelId &&
          existing.repository === input.repository &&
          (existing.baseRef ?? null) === (input.baseRef ?? null) &&
          existing.prompt === input.prompt &&
          existing.parentSessionId === input.parentSessionId &&
          existing.resumePrompt === input.resumePrompt &&
          (legacyAlias ||
            canonicalJson(existing.requestedSelection ?? null) ===
              canonicalJson(input.requestedSelection ?? null)) &&
          existing.executorKind === agentRunExecutorKind(input)
        if (exact) return { status: "duplicate" as const }
        return yield* Effect.fail(
          conflict(input.runId, "run identity exists with different submission fields"),
        )
      }
      const mailboxId = `agent-mailbox-${randomBytes(32).toString("hex")}`
      yield* sql`INSERT INTO kernel_agent_runs (run_id, caller_mailbox_id, route, provider_id, model_id, agent,
        repository, base_ref, directory, prompt, prompt_sha256, parent_session_id, resume_prompt, state,
        attempt, max_attempts, created_at, updated_at, executor_kind, requested_selection, resolved_selection)
        VALUES (${input.runId}, ${mailboxId}, ${input.route}, ${input.providerId}, ${input.modelId},
        ${input.agent}, ${input.repository}, ${input.baseRef ?? null}, ${input.directory}, ${input.prompt},
        ${input.promptSha256}, ${input.parentSessionId}, ${input.resumePrompt}, 'accepted', 1,
        ${input.maxAttempts}, ${input.createdAt.toISOString()}, ${input.createdAt.toISOString()},
        ${agentRunExecutorKind(input)},
        ${input.requestedSelection === undefined ? null : JSON.stringify(input.requestedSelection)},
        ${input.resolvedSelection === undefined ? null : JSON.stringify(input.resolvedSelection)})`
      return { status: "created" as const }
    }).pipe(sql.withTransaction)

  /**
   * Exactly one dispatching request wins the accepted→spawning transition;
   * a concurrent duplicate conflicts here BEFORE any external side effect,
   * so identical retries can never double-spawn sessions.
   */
  const claimSpawn: AgentRunStorePort["claimSpawn"] = (input) =>
    transition(
      input.runId,
      "run is not in accepted state; another dispatch may hold the spawn",
      sql`UPDATE kernel_agent_runs SET state = 'spawning',
        updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state = 'accepted' RETURNING run_id`,
    )

  const abandonLaunch: AgentRunStorePort["abandonLaunch"] = (input) =>
    transition(
      input.runId,
      "run is not an incomplete launch",
      sql`DELETE FROM kernel_agent_runs
        WHERE run_id = ${input.runId} AND state = 'spawning' RETURNING run_id`,
    )

  const markSpawned: AgentRunStorePort["markSpawned"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* readRow(input.runId)
      if (
        existing !== null &&
        existing.state !== "accepted" &&
        existing.state !== "spawning" &&
        existing.sessionId === input.sessionId &&
        existing.nativeSessionId === input.nativeSessionId
      ) {
        return
      }
      yield* transition(
        input.runId,
        "run is not in spawning state",
        sql`UPDATE kernel_agent_runs SET state = 'spawned', resource_id = ${input.resourceId},
          session_id = ${input.sessionId}, native_session_id = ${input.nativeSessionId},
          updated_at = ${input.now.toISOString()}
          WHERE run_id = ${input.runId} AND state = 'spawning' RETURNING run_id`,
      )
    }).pipe(sql.withTransaction)

  const markVerified: AgentRunStorePort["markVerified"] = (input) =>
    transition(
      input.runId,
      "run is not in spawned state",
      sql`UPDATE kernel_agent_runs SET state = 'verified',
        last_output_tokens = ${input.outputTokens},
        last_progress_at = ${input.now.toISOString()}, updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state IN ('spawned', 'verified') RETURNING run_id`,
    )

  const recordProgress: AgentRunStorePort["recordProgress"] = (input) =>
    transition(
      input.runId,
      "run is not in verified state",
      sql`UPDATE kernel_agent_runs SET last_output_tokens = ${input.outputTokens},
        last_progress_at = ${input.now.toISOString()}, updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state = 'verified' RETURNING run_id`,
    )

  const touch: AgentRunStorePort["touch"] = (input) =>
    transition(
      input.runId,
      "run is not active",
      sql`UPDATE kernel_agent_runs SET updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state IN ('accepted', 'spawning', 'spawned', 'verified')
        RETURNING run_id`,
    )

  const beginAttempt: AgentRunStorePort["beginAttempt"] = (input) =>
    transition(
      input.runId,
      "run is not in verified state or attempt is not the successor",
      sql`UPDATE kernel_agent_runs SET attempt = ${input.attempt},
        diagnostic = ${input.diagnostic}, last_progress_at = ${input.now.toISOString()},
        updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state = 'verified'
        AND attempt = ${input.attempt - 1} AND attempt < max_attempts RETURNING run_id`,
    )

  const terminal = (
    runId: string,
    now: Date,
    endReason: string,
    finalMessage: string | null,
    change: Effect.Effect<void, AgentRunStoreError>,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* change
        const run = yield* readRow(runId)
        if (run === null) return
        const prompt = JSON.stringify({
          run_id: run.runId,
          session_id: run.sessionId,
          native_session_id: run.nativeSessionId,
          route: run.route,
          model: run.resolvedSelection?.model ?? run.modelId,
          executor: agentRunExecutorKind(run),
          status: run.state,
          end_reason: endReason,
          ended_at: now.toISOString(),
          final_message: finalMessage,
          final_message_ref: finalMessage === null ? run.nativeSessionId : null,
        })
        yield* sql`INSERT INTO resident_inbox (id,thread_id,mailbox_id,prompt,state)
          VALUES (${"agent-run-end-" + runId},NULL,${run.callerMailboxId},${prompt},'prepared')
          ON CONFLICT(id) DO NOTHING`
      }),
    )

  const complete: AgentRunStorePort["complete"] = (input) =>
    terminal(
      input.runId,
      input.now,
      "completed",
      input.finalMessage ?? null,
      transition(
        input.runId,
        "run is not in verified state",
        sql`UPDATE kernel_agent_runs SET state = 'completed',
        updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state = 'verified' RETURNING run_id`,
      ),
    )

  const cancel: AgentRunStorePort["cancel"] = (input) =>
    terminal(
      input.runId,
      input.now,
      input.diagnostic ?? "cancelled",
      null,
      transition(
        input.runId,
        "run is not cancellable",
        sql`UPDATE kernel_agent_runs SET state = 'cancelled', diagnostic = ${input.diagnostic ?? null},
        updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND (state IN ('accepted', 'spawning', 'spawned', 'verified')
          OR (state = 'operator_required' AND executor_kind IN ('codex', 'claude')))
        RETURNING run_id`,
      ),
    )

  const fail: AgentRunStorePort["fail"] = (input) =>
    terminal(
      input.runId,
      input.now,
      input.diagnostic,
      input.finalMessage ?? null,
      transition(
        input.runId,
        "run is not in a failable state",
        sql`UPDATE kernel_agent_runs SET state = 'failed', diagnostic = ${input.diagnostic},
        updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state IN ('accepted', 'spawning', 'spawned') RETURNING run_id`,
      ),
    )

  const operatorRequired: AgentRunStorePort["operatorRequired"] = (input) =>
    terminal(
      input.runId,
      input.now,
      input.diagnostic,
      input.finalMessage ?? null,
      transition(
        input.runId,
        "run is not active",
        sql`UPDATE kernel_agent_runs SET state = 'operator_required',
        diagnostic = ${input.diagnostic}, updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state IN ('accepted', 'spawning', 'spawned', 'verified', 'operator_required')
        RETURNING run_id`,
      ),
    )

  const nextWatchable: AgentRunStorePort["nextWatchable"] = (input) =>
    Effect.gen(function* () {
      const staleBefore = new Date(input.now.getTime() - input.staleAfterMs).toISOString()
      const verified =
        input.unsupervisedExecutorKinds.length === 0
          ? sql`state = 'verified'`
          : sql`state = 'verified'
        AND executor_kind NOT IN ${sql.in(input.unsupervisedExecutorKinds)}`
      const externallySupervised =
        input.unsupervisedExecutorKinds.length === 0
          ? sql`1 = 1`
          : sql`executor_kind NOT IN ${sql.in(input.unsupervisedExecutorKinds)}`
      const rows = yield* sql`SELECT * FROM kernel_agent_runs
        WHERE (${verified}) AND NOT EXISTS (
          SELECT 1 FROM resident_threads t WHERE t.run_id = kernel_agent_runs.run_id
          AND t.provider_kind = 'opencode' AND (
            EXISTS (SELECT 1 FROM kernel_workflow_instances i JOIN kernel_waits w ON w.instance_id = i.instance_id
              WHERE i.workflow_type = 'mailbox_subscription' AND i.workflow_key = t.thread_id AND w.state IN ('pending','matched'))
            OR EXISTS (SELECT 1 FROM resident_inbox m WHERE m.thread_id = t.thread_id AND m.state IN ('prepared','sending'))
          )
        )
        OR (state IN ('accepted', 'spawning', 'spawned') AND ${externallySupervised} AND updated_at < ${staleBefore})
        ORDER BY updated_at, run_id LIMIT 1`
      return rows.length === 0 ? null : yield* toRecord(rows[0]!)
    })

  const listActiveByProvider: AgentRunStorePort["listActiveByProvider"] = (
    providerId,
    transientOnly = false,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM kernel_agent_runs
        WHERE provider_id = ${providerId} AND state IN ('spawning', 'spawned', 'verified')
        AND (${transientOnly ? 1 : 0} = 0 OR NOT EXISTS (
          SELECT 1 FROM resident_threads t WHERE t.run_id = kernel_agent_runs.run_id
        ))
        ORDER BY created_at, run_id`
      return yield* Effect.forEach(rows, toRecord)
    })

  const listActiveByExecutor: AgentRunStorePort["listActiveByExecutor"] = (
    kind,
    transientOnly = false,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM kernel_agent_runs
        WHERE executor_kind = ${kind} AND state IN ('spawning', 'spawned', 'verified')
        AND (${transientOnly ? 1 : 0} = 0 OR NOT EXISTS (
          SELECT 1 FROM resident_threads t WHERE t.run_id = kernel_agent_runs.run_id
        )) ORDER BY created_at, run_id`
      return yield* Effect.forEach(rows, toRecord)
    })

  return AgentRunStore.of({
    recordResolvedSelection: (input) =>
      transition(
        input.runId,
        "selection evidence requires an active run",
        sql`UPDATE kernel_agent_runs SET resolved_selection = ${JSON.stringify(input.selection)}, updated_at = ${input.now.toISOString()} WHERE run_id = ${input.runId} AND state IN ('accepted','spawning','spawned','verified') RETURNING run_id`,
      ),
    create,
    claimSpawn,
    abandonLaunch,
    read: readRow,
    markSpawned,
    markVerified,
    recordProgress,
    touch,
    beginAttempt,
    complete,
    cancel,
    fail,
    operatorRequired,
    nextWatchable,
    listActiveByProvider,
    listActiveByExecutor,
  })
})

export const AgentRunStoreLive = Layer.effect(AgentRunStore, make)

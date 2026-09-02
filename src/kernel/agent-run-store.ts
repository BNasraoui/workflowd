import { SqlClient } from "effect/unstable/sql"
import { Context, Data, Effect, Layer, Schema } from "effect"

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
 * receipt has been issued) → completed | failed | operator_required.
 */
export type AgentRunState =
  "accepted" | "spawning" | "spawned" | "verified" | "completed" | "failed" | "operator_required"

const AgentRunRow = Schema.Struct({
  run_id: Schema.String,
  route: Schema.String,
  provider_id: Schema.String,
  model_id: Schema.String,
  agent: Schema.String,
  repository: Schema.String,
  directory: Schema.String,
  prompt: Schema.String,
  parent_session_id: Schema.NullOr(Schema.String),
  resume_prompt: Schema.NullOr(Schema.String),
  resource_id: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  native_session_id: Schema.NullOr(Schema.String),
  worktree_branch: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "accepted",
    "spawning",
    "spawned",
    "verified",
    "completed",
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
  readonly runId: string
  readonly route: string
  readonly providerId: string
  readonly modelId: string
  readonly agent: string
  readonly repository: string
  readonly directory: string
  readonly prompt: string
  readonly parentSessionId: string | null
  readonly resumePrompt: string | null
  readonly resourceId: string | null
  readonly sessionId: string | null
  readonly nativeSessionId: string | null
  readonly worktreeBranch: string | null
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
  readonly runId: string
  readonly route: string
  readonly providerId: string
  readonly modelId: string
  readonly agent: string
  readonly repository: string
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

export type AgentRunStorePort = {
  readonly create: (
    input: AgentRunCreateInput,
  ) => Effect.Effect<{ readonly status: "created" | "duplicate" }, AgentRunStoreError>
  readonly claimSpawn: (input: Authority) => Effect.Effect<void, AgentRunStoreError>
  readonly read: (runId: string) => Effect.Effect<AgentRunRecord | null, AgentRunStoreError>
  readonly markSpawned: (
    input: Authority & {
      readonly resourceId: string
      readonly sessionId: string
      readonly nativeSessionId: string
      readonly worktreeBranch: string
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
  readonly complete: (input: Authority) => Effect.Effect<void, AgentRunStoreError>
  readonly fail: (
    input: Authority & { readonly diagnostic: string },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly operatorRequired: (
    input: Authority & { readonly diagnostic: string },
  ) => Effect.Effect<void, AgentRunStoreError>
  readonly nextWatchable: (input: {
    readonly now: Date
    readonly staleAfterMs: number
  }) => Effect.Effect<AgentRunRecord | null, AgentRunStoreError>
}

export const AgentRunStore = Context.Service<AgentRunStorePort>("workflowd/kernel/AgentRunStore")

const toRecord = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(AgentRunRow)(row).pipe(
    Effect.mapError(
      (error) => new AgentRunStoreDataError({ runId: String(row.run_id), message: String(error) }),
    ),
    Effect.map((decoded): AgentRunRecord => ({
      runId: decoded.run_id,
      route: decoded.route,
      providerId: decoded.provider_id,
      modelId: decoded.model_id,
      agent: decoded.agent,
      repository: decoded.repository,
      directory: decoded.directory,
      prompt: decoded.prompt,
      parentSessionId: decoded.parent_session_id,
      resumePrompt: decoded.resume_prompt,
      resourceId: decoded.resource_id,
      sessionId: decoded.session_id,
      nativeSessionId: decoded.native_session_id,
      worktreeBranch: decoded.worktree_branch,
      state: decoded.state,
      attempt: decoded.attempt,
      maxAttempts: decoded.max_attempts,
      lastOutputTokens: decoded.last_output_tokens,
      lastProgressAt: decoded.last_progress_at === null ? null : new Date(decoded.last_progress_at),
      diagnostic: decoded.diagnostic,
      createdAt: new Date(decoded.created_at),
      updatedAt: new Date(decoded.updated_at),
    })),
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
        const exact =
          existing.route === input.route &&
          existing.providerId === input.providerId &&
          existing.modelId === input.modelId &&
          existing.repository === input.repository &&
          existing.prompt === input.prompt &&
          existing.parentSessionId === input.parentSessionId &&
          existing.resumePrompt === input.resumePrompt
        if (exact) return { status: "duplicate" as const }
        return yield* Effect.fail(
          conflict(input.runId, "run identity exists with different submission fields"),
        )
      }
      yield* sql`INSERT INTO kernel_agent_runs (run_id, route, provider_id, model_id, agent,
        repository, directory, prompt, prompt_sha256, parent_session_id, resume_prompt, state,
        attempt, max_attempts, created_at, updated_at)
        VALUES (${input.runId}, ${input.route}, ${input.providerId}, ${input.modelId},
        ${input.agent}, ${input.repository}, ${input.directory}, ${input.prompt},
        ${input.promptSha256}, ${input.parentSessionId}, ${input.resumePrompt}, 'accepted', 1,
        ${input.maxAttempts}, ${input.createdAt.toISOString()}, ${input.createdAt.toISOString()})`
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

  const markSpawned: AgentRunStorePort["markSpawned"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* readRow(input.runId)
      if (
        existing !== null &&
        existing.state !== "accepted" &&
        existing.state !== "spawning" &&
        existing.sessionId === input.sessionId &&
        existing.nativeSessionId === input.nativeSessionId &&
        existing.worktreeBranch === input.worktreeBranch
      ) {
        return
      }
      yield* transition(
        input.runId,
        "run is not in spawning state",
        sql`UPDATE kernel_agent_runs SET state = 'spawned', resource_id = ${input.resourceId},
          session_id = ${input.sessionId}, native_session_id = ${input.nativeSessionId},
          worktree_branch = ${input.worktreeBranch},
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

  const complete: AgentRunStorePort["complete"] = (input) =>
    transition(
      input.runId,
      "run is not in verified state",
      sql`UPDATE kernel_agent_runs SET state = 'completed',
        updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state = 'verified' RETURNING run_id`,
    )

  const fail: AgentRunStorePort["fail"] = (input) =>
    transition(
      input.runId,
      "run is not in a failable state",
      sql`UPDATE kernel_agent_runs SET state = 'failed', diagnostic = ${input.diagnostic},
        updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state IN ('accepted', 'spawning', 'spawned') RETURNING run_id`,
    )

  const operatorRequired: AgentRunStorePort["operatorRequired"] = (input) =>
    transition(
      input.runId,
      "run is not active",
      sql`UPDATE kernel_agent_runs SET state = 'operator_required',
        diagnostic = ${input.diagnostic}, updated_at = ${input.now.toISOString()}
        WHERE run_id = ${input.runId} AND state IN ('accepted', 'spawning', 'spawned', 'verified')
        RETURNING run_id`,
    )

  const nextWatchable: AgentRunStorePort["nextWatchable"] = (input) =>
    Effect.gen(function* () {
      const staleBefore = new Date(input.now.getTime() - input.staleAfterMs).toISOString()
      const rows = yield* sql`SELECT * FROM kernel_agent_runs
        WHERE state = 'verified'
        OR (state IN ('accepted', 'spawning', 'spawned') AND updated_at < ${staleBefore})
        ORDER BY updated_at, run_id LIMIT 1`
      return rows.length === 0 ? null : yield* toRecord(rows[0]!)
    })

  return AgentRunStore.of({
    create,
    claimSpawn,
    read: readRow,
    markSpawned,
    markVerified,
    recordProgress,
    touch,
    beginAttempt,
    complete,
    fail,
    operatorRequired,
    nextWatchable,
  })
})

export const AgentRunStoreLive = Layer.effect(AgentRunStore, make)

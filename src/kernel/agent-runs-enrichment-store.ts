import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { enrichmentDocument, omitNull, type EnrichmentDocument } from "./enrichment-read-model"

/**
 * Read-only agent-run enrichment for OpenMob.
 *
 * OpenMob session cards need the worktree branch and repository a dispatched
 * agent run works in, keyed by the harness-native session id it already
 * holds. This store joins kernel_sessions to kernel_agent_runs and is
 * workflowd's dispatch ground truth; the only coupling is the
 * `agent-runs-enrichment/v1` JSON document produced here and served at
 * GET /workflows/agent-runs.
 *
 * Field names are snake_case on purpose: they are the contract's JSON keys,
 * serialized verbatim, so consumers pass values through untouched.
 */
export const AGENT_RUNS_ENRICHMENT_CONTRACT = "agent-runs-enrichment/v1"

export type AgentRunEnrichment = {
  readonly repository?: string
  readonly worktree_branch?: string
  readonly state?: string
  readonly created_at?: string
  readonly updated_at?: string
}

export type AgentRunsEnrichmentDocument = EnrichmentDocument<
  AgentRunEnrichment,
  typeof AGENT_RUNS_ENRICHMENT_CONTRACT
>

export class AgentRunsEnrichmentStoreDataError extends Data.TaggedError(
  "AgentRunsEnrichmentStoreDataError",
)<{
  readonly message: string
}> {}

export type AgentRunsEnrichmentStoreError = SqlError | AgentRunsEnrichmentStoreDataError

export type AgentRunsEnrichmentStorePort = {
  /** A fresh read-only snapshot; the query never writes to the store. */
  readonly sessions: () => Effect.Effect<AgentRunsEnrichmentDocument, AgentRunsEnrichmentStoreError>
}

export const AgentRunsEnrichmentStore = Context.Service<AgentRunsEnrichmentStorePort>(
  "workflowd/kernel/AgentRunsEnrichmentStore",
)

const EnrichmentRow = Schema.Struct({
  native_session_id: Schema.String,
  repository: Schema.NullOr(Schema.String),
  worktree_branch: Schema.NullOr(Schema.String),
  state: Schema.NullOr(
    Schema.Literals([
      "accepted",
      "spawning",
      "spawned",
      "verified",
      "completed",
      "failed",
      "operator_required",
    ]),
  ),
  created_at: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
})

/** A session with no agent run omits the run fields — never emits nulls. */
const toEnrichment = (row: Schema.Schema.Type<typeof EnrichmentRow>): AgentRunEnrichment => ({
  ...omitNull("repository", row.repository),
  ...omitNull("worktree_branch", row.worktree_branch),
  ...omitNull("state", row.state),
  ...omitNull("created_at", row.created_at),
  ...omitNull("updated_at", row.updated_at),
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const sessions: AgentRunsEnrichmentStorePort["sessions"] = () =>
    enrichmentDocument({
      contract: AGENT_RUNS_ENRICHMENT_CONTRACT,
      row: EnrichmentRow,
      toEnrichment,
      dataError: (message) => new AgentRunsEnrichmentStoreDataError({ message }),
    })(sql`
      SELECT s.native_session_id,
        r.repository AS repository,
        r.worktree_branch AS worktree_branch,
        r.state AS state,
        r.created_at AS created_at,
        r.updated_at AS updated_at
      FROM kernel_sessions s
      LEFT JOIN kernel_agent_runs r ON r.run_id = (
        SELECT r2.run_id FROM kernel_agent_runs r2
        WHERE r2.session_id = s.session_id
        ORDER BY r2.updated_at DESC, r2.run_id DESC
        LIMIT 1
      )
      WHERE s.native_session_id IS NOT NULL AND s.native_session_id <> ''
      ORDER BY s.native_session_id
    `)

  return AgentRunsEnrichmentStore.of({ sessions })
})

export const AgentRunsEnrichmentStoreLive = Layer.effect(AgentRunsEnrichmentStore, make)

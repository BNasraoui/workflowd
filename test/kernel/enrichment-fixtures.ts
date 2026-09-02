import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import type { AgentRunCreateInput } from "../../src/kernel/agent-run-store"
import { KernelSessionStore } from "../../src/kernel/session-store"

/** Shared clock for the custody + dispatch fixtures below. */
export const at = new Date("2026-08-30T09:00:00.000Z")
export const later = new Date("2026-08-30T09:05:00.000Z")

/** The custody worktree directory dispatches land in. */
export const dispatchDirectory = "/srv/worktrees/agent-runs/child"

/** One agent-run create row destined for a dispatchable worktree directory. */
export const agentRunInput = (input: {
  readonly runId: string
  readonly directory: string
  readonly createdAt: Date
}): AgentRunCreateInput => ({
  runId: input.runId,
  route: "implement",
  providerId: "zai-coding-plan",
  modelId: "zai-coding-plan/glm-5.3-flash",
  agent: "remote-worker",
  repository: "workflowd",
  directory: input.directory,
  prompt: "Fix the flaky retry test.",
  promptSha256: "a".repeat(64),
  parentSessionId: null,
  resumePrompt: null,
  maxAttempts: 3,
  createdAt: input.createdAt,
})

/** One custody session with no agent run, one with dispatches to follow. */
export const registerCustody = Effect.gen(function* () {
  const sessions = yield* KernelSessionStore
  yield* sessions.registerResource({
    resourceId: "resource-mint",
    owningHostId: "mint",
    absolutePath: "/srv/worktrees/agent-runs/idle",
    kind: "worktree",
    createdAt: at,
  })
  yield* sessions.registerResource({
    resourceId: "resource-gpu",
    owningHostId: "gpu-box",
    absolutePath: "/srv/worktrees/agent-runs/child",
    kind: "worktree",
    createdAt: at,
  })
  yield* sessions.registerSession({
    sessionId: "session-idle",
    providerKind: "opencode",
    providerVersion: 3,
    providerId: "opencode-primary",
    serverId: "opencode-primary",
    owningHostId: "mint",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    nativeSessionId: "ses_idle",
    resourceId: "resource-mint",
    createdAt: at,
  })
  yield* sessions.registerSession({
    sessionId: "session-dispatched",
    providerKind: "claude",
    providerVersion: 1,
    providerId: "claude-primary",
    serverId: "claude-primary",
    owningHostId: "gpu-box",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4097",
    nativeSessionId: "ses_dispatched",
    resourceId: "resource-gpu",
    createdAt: at,
  })
})

/** A custody row whose native session id violates today's non-empty guard. */
export const insertBlankNativeSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Custody guarantees a non-empty native id today; the read model still
  // owes the contract the skip, so it fences the row out at the query.
  yield* sql`PRAGMA ignore_check_constraints = ON`
  yield* sql`INSERT INTO kernel_sessions (
    session_id, provider_kind, provider_version, provider_id, server_id,
    owning_host_id, endpoint_alias, endpoint_identity, native_session_id,
    resource_id, state, revision, created_at, updated_at
  ) VALUES (
    'session-blank', 'opencode', 1, 'p', 's', 'mint', 'a', 'i', '',
    'resource-mint', 'ready', 1, ${at.toISOString()}, ${at.toISOString()}
  )`
  yield* sql`PRAGMA ignore_check_constraints = OFF`
})

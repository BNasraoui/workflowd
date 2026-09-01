import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer } from "effect"
import {
  AgentRunStore,
  AgentRunStoreLive,
  type AgentRunCreateInput,
} from "../../src/kernel/agent-run-store"
import {
  AGENT_RUNS_ENRICHMENT_CONTRACT,
  AgentRunsEnrichmentStore,
  AgentRunsEnrichmentStoreLive,
} from "../../src/kernel/agent-runs-enrichment-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"

const at = new Date("2026-08-30T09:00:00.000Z")
const later = new Date("2026-08-30T09:05:00.000Z")

const layer = Layer.mergeAll(
  AgentRunStoreLive,
  KernelSessionStoreLive,
  AgentRunsEnrichmentStoreLive,
).pipe(
  Layer.provideMerge(
    WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  ),
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const runInput = (runId: string, directory: string, createdAt: Date): AgentRunCreateInput => ({
  runId,
  route: "implement",
  providerId: "zai-coding-plan",
  modelId: "zai-coding-plan/glm-5.3-flash",
  agent: "remote-worker",
  repository: "workflowd",
  directory,
  prompt: "Fix the flaky retry test.",
  promptSha256: "a".repeat(64),
  parentSessionId: null,
  resumePrompt: null,
  maxAttempts: 3,
  createdAt,
})

/** One custody session with no agent run, one with dispatches to follow. */
const registerCustody = Effect.gen(function* () {
  const sessions = yield* KernelSessionStore
  yield* sessions.registerResource({
    resourceId: "resource-mint",
    owningHostId: "mint",
    absolutePath: "/tmp/worktrees/agent-runs/idle",
    kind: "worktree",
    createdAt: at,
  })
  yield* sessions.registerResource({
    resourceId: "resource-gpu",
    owningHostId: "gpu-box",
    absolutePath: "/tmp/worktrees/agent-runs/child",
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

const dispatchRun = (input: {
  readonly runId: string
  readonly directory: string
  readonly branch: string
  readonly sessionId?: string
  readonly spawnedAt: Date
}) =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    yield* runs.create(runInput(input.runId, input.directory, at))
    yield* runs.claimSpawn({ runId: input.runId, now: at })
    yield* runs.markSpawned({
      runId: input.runId,
      resourceId: "resource-gpu",
      sessionId: input.sessionId ?? "session-dispatched",
      nativeSessionId: "ses_dispatched",
      worktreeBranch: input.branch,
      now: input.spawnedAt,
    })
  })

const completeRun = (runId: string, now: Date) =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    yield* runs.markVerified({ runId, outputTokens: 5, now })
    yield* runs.complete({ runId, now })
  })

describe("agent-runs enrichment store", () => {
  test("keys every custody session by native id with its run ground truth", async () => {
    const document = await run(
      Effect.gen(function* () {
        yield* registerCustody
        yield* dispatchRun({
          runId: "run-1",
          directory: "/tmp/worktrees/agent-runs/child",
          branch: "agent-run/child",
          spawnedAt: at,
        })
        yield* completeRun("run-1", at)
        const store = yield* AgentRunsEnrichmentStore
        return yield* store.sessions()
      }),
    )

    expect(document.contract).toBe(AGENT_RUNS_ENRICHMENT_CONTRACT)
    expect(document.sessions).toEqual({
      // A session with no agent run omits the run fields instead of nulling them.
      ses_idle: {},
      ses_dispatched: {
        repository: "workflowd",
        worktree_branch: "agent-run/child",
        state: "completed",
        created_at: at.toISOString(),
        updated_at: at.toISOString(),
      },
    })
  })

  test("prefers the most recently updated agent run when runs share a session", async () => {
    const document = await run(
      Effect.gen(function* () {
        yield* registerCustody
        yield* dispatchRun({
          runId: "run-old",
          directory: "/tmp/worktrees/agent-runs/older",
          branch: "agent-run/older",
          spawnedAt: at,
        })
        yield* dispatchRun({
          runId: "run-new",
          directory: "/tmp/worktrees/agent-runs/newer",
          branch: "agent-run/newer",
          spawnedAt: later,
        })
        const store = yield* AgentRunsEnrichmentStore
        return yield* store.sessions()
      }),
    )

    expect(document.sessions.ses_dispatched).toEqual({
      repository: "workflowd",
      worktree_branch: "agent-run/newer",
      state: "spawned",
      created_at: at.toISOString(),
      updated_at: later.toISOString(),
    })
  })

  test("skips sessions whose native session id is null or empty", async () => {
    const document = await run(
      Effect.gen(function* () {
        yield* registerCustody
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
        const store = yield* AgentRunsEnrichmentStore
        return yield* store.sessions()
      }),
    )

    expect(Object.keys(document.sessions).sort()).toEqual(["ses_dispatched", "ses_idle"])
  })
})

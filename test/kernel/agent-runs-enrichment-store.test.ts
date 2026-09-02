import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import {
  AGENT_RUNS_ENRICHMENT_CONTRACT,
  AgentRunsEnrichmentStore,
  AgentRunsEnrichmentStoreLive,
} from "../../src/kernel/agent-runs-enrichment-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import {
  agentRunInput,
  at,
  insertBlankNativeSession,
  later,
  registerCustody,
} from "./enrichment-fixtures"

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

const dispatchRun = (input: {
  readonly runId: string
  readonly directory: string
  readonly branch: string
  readonly sessionId?: string
  readonly spawnedAt: Date
}) =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    yield* runs.create(
      agentRunInput({ runId: input.runId, directory: input.directory, createdAt: at }),
    )
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
          directory: "/srv/worktrees/agent-runs/child",
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
          directory: "/srv/worktrees/agent-runs/older",
          branch: "agent-run/older",
          spawnedAt: at,
        })
        yield* dispatchRun({
          runId: "run-new",
          directory: "/srv/worktrees/agent-runs/newer",
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
        yield* insertBlankNativeSession
        const store = yield* AgentRunsEnrichmentStore
        return yield* store.sessions()
      }),
    )

    expect(Object.keys(document.sessions).sort()).toEqual(["ses_dispatched", "ses_idle"])
  })
})

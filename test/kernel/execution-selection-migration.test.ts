import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  AgentRunStore,
  AgentRunStoreLive,
  AgentRunStoreDataError,
} from "../../src/kernel/agent-run-store"
import { runStoreMigrationsThrough0019, runStoreMigrations } from "../../src/store/migrations"

test("migration retains legacy rows, separates executors and rejects malformed stored selections", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* runStoreMigrationsThrough0019
      for (const provider of ["opencode-provider", "codex-cli", "claude-cli"])
        yield* sql`INSERT INTO kernel_agent_runs(run_id,route,provider_id,model_id,agent,repository,directory,prompt,prompt_sha256,state,attempt,max_attempts,created_at,updated_at) VALUES(${provider},'legacy',${provider},'configured','build','repo','/repo','prompt',${"a".repeat(64)},'accepted',1,3,'2026-10-01','2026-10-01')`
      yield* runStoreMigrations
      const store = yield* AgentRunStore
      for (const [id, kind] of [
        ["opencode-provider", "opencode"],
        ["codex-cli", "codex"],
        ["claude-cli", "claude"],
      ] as const) {
        const row = yield* store.read(id)
        expect(row?.executorKind).toBe(kind)
        expect(row?.resolvedSelection).toBeNull()
        expect(row?.modelId).toBe("configured")
        yield* store.claimSpawn({ runId: id, now: new Date("2026-10-01") })
        expect((yield* store.listActiveByExecutor(kind, true)).map((run) => run.runId)).toEqual([
          id,
        ])
      }
      expect(
        (yield* store.nextWatchable({
          now: new Date("2026-10-02"),
          staleAfterMs: 1000,
          unsupervisedExecutorKinds: ["codex", "claude"],
        }))?.runId,
      ).toBe("opencode-provider")
      expect(
        yield* store.create({
          runId: "codex-cli",
          route: "legacy",
          providerId: "codex-cli",
          modelId: "configured",
          requestedSelection: { route: "legacy" },
          agent: "build",
          repository: "repo",
          directory: "/repo",
          prompt: "prompt",
          promptSha256: "a".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 3,
          createdAt: new Date("2026-10-01"),
        }),
      ).toEqual({ status: "duplicate" })
      yield* sql`UPDATE kernel_agent_runs SET resolved_selection = 'bad json' WHERE run_id = 'codex-cli'`
      const corrupt = yield* store.read("codex-cli").pipe(Effect.result)
      expect(corrupt._tag).toBe("Failure")
      if (corrupt._tag === "Failure") expect(corrupt.failure).toBeInstanceOf(AgentRunStoreDataError)
    }).pipe(
      Effect.provide(
        AgentRunStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  )
})

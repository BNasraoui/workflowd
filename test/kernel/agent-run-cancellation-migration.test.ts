import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { runStoreMigrations, runStoreMigrationsThrough0019 } from "../../src/store/migrations"

test("cancellation migration preserves existing runs and indexes and widens state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* runStoreMigrationsThrough0019
      yield* sql`INSERT INTO kernel_agent_runs (run_id, route, provider_id, model_id, agent,
        repository, directory, prompt, prompt_sha256, state, attempt, max_attempts, created_at,
        updated_at) VALUES ('child', 'test', 'codex-cli', 'm', 'build', 'o/r', '/child',
        'task', ${"a".repeat(64)}, 'accepted', 1, 1, '2026-09-29', '2026-09-29')`
      const before = yield* sql`SELECT * FROM kernel_agent_runs`
      expect(
        (yield* sql`UPDATE kernel_agent_runs SET state = 'cancelled'`.pipe(Effect.result))._tag,
      ).toBe("Failure")
      yield* runStoreMigrations
      expect(yield* sql`SELECT * FROM kernel_agent_runs`).toEqual(
        before.map((row) => ({
          ...row,
          executor_kind: "codex",
          requested_selection: null,
          resolved_selection: null,
        })),
      )
      yield* sql`UPDATE kernel_agent_runs SET state = 'cancelled'`
      expect(yield* sql`SELECT state FROM kernel_agent_runs`).toEqual([{ state: "cancelled" }])
      expect(
        (yield* sql`UPDATE kernel_agent_runs SET state = 'invalid'`.pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
      const indexes = yield* sql`PRAGMA index_list(kernel_agent_runs)`
      expect(indexes.map((row) => row.name)).toContain("kernel_agent_runs_watchable")
      expect(indexes.map((row) => row.name)).toContain("kernel_agent_runs_session")
      yield* runStoreMigrations
      expect(yield* sql`SELECT state FROM kernel_agent_runs`).toEqual([{ state: "cancelled" }])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))

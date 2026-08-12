import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { runWithStore } from "../store/harness"

describe("custody audit schema", () => {
  test("keys cleanup outcomes and observations once per attempt with attempt foreign keys", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const cleanupIndexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kernel_cleanup_outcomes'`
        const observationIndexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kernel_resume_observations'`
        const cleanupForeignKeys = yield* sql<{
          readonly table: string
          readonly from: string
          readonly to: string
        }>`PRAGMA foreign_key_list('kernel_cleanup_outcomes')`
        return { cleanupForeignKeys, cleanupIndexes, observationIndexes }
      }),
    )

    const normalized = (sql: string | null) => sql?.replaceAll(/\s+/g, " ")
    expect(result.cleanupIndexes.map(({ sql }) => normalized(sql))).toContain(
      "CREATE UNIQUE INDEX kernel_cleanup_outcomes_attempt ON kernel_cleanup_outcomes (cleanup_id, attempt)",
    )
    expect(result.observationIndexes.map(({ sql }) => normalized(sql))).toContain(
      "CREATE UNIQUE INDEX kernel_resume_observations_attempt ON kernel_resume_observations (request_id, attempt)",
    )
    expect(
      result.cleanupForeignKeys.some(
        (row) =>
          row.table === "kernel_cleanup_attempts" &&
          row.from === "cleanup_id" &&
          row.to === "cleanup_id",
      ),
    ).toBe(true)
    expect(
      result.cleanupForeignKeys.some(
        (row) =>
          row.table === "kernel_cleanup_attempts" && row.from === "attempt" && row.to === "attempt",
      ),
    ).toBe(true)
    expect(
      result.cleanupForeignKeys.some(
        (row) =>
          row.table === "kernel_cleanup_attempts" &&
          row.from === "owning_host_id" &&
          row.to === "owning_host_id",
      ),
    ).toBe(true)
  })

  test("enforces owning host through composite foreign keys", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const names = [
          "kernel_sessions",
          "kernel_resume_requests",
          "kernel_resume_attempts",
          "kernel_cleanup_requests",
          "kernel_cleanup_attempts",
        ]
        return yield* Effect.forEach(names, (name) =>
          sql
            .unsafe<{ readonly table: string; readonly from: string; readonly to: string }>(
              `PRAGMA foreign_key_list('${name}')`,
            )
            .pipe(Effect.map((rows) => [name, rows] as const)),
        )
      }),
    )
    const hasHostKey = (name: string, table: string) =>
      result
        .find(([key]) => key === name)?.[1]
        .some(
          (row) =>
            row.table === table && row.from === "owning_host_id" && row.to === "owning_host_id",
        )
    expect(hasHostKey("kernel_sessions", "kernel_working_resources")).toBe(true)
    expect(hasHostKey("kernel_resume_requests", "kernel_sessions")).toBe(true)
    expect(hasHostKey("kernel_resume_attempts", "kernel_resume_requests")).toBe(true)
    expect(hasHostKey("kernel_cleanup_requests", "kernel_working_resources")).toBe(true)
  })
})

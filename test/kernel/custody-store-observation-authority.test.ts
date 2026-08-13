import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { runWithStore } from "../store/harness"

describe("observation authority schema", () => {
  test("persists bounded observer host, worker, and token", async () => {
    const columns = await runWithStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          readonly name: string
        }>`SELECT name FROM pragma_table_info('kernel_resume_observations')
        ORDER BY cid`
      }),
    )
    expect(columns.map(({ name }) => name)).toEqual([
      "observation_id",
      "request_id",
      "attempt",
      "observer_host_id",
      "observer_worker_id",
      "observer_token",
      "disposition",
      "evidence_version",
      "evidence_json",
      "observed_at",
    ])
  })
})

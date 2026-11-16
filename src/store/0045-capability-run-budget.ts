import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/**
 * The budget of each run that workflowd has authorized to the capability gateway, fixed when it
 * first authorizes the run; every later grant of the run sends this row, whatever the config says.
 */
export const capabilityRunBudget = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE capability_run_budgets (
    run_id TEXT PRIMARY KEY REFERENCES kernel_agent_runs(run_id) ON DELETE CASCADE,
    calls INTEGER NOT NULL CHECK(calls>0),
    output_tokens INTEGER NOT NULL CHECK(output_tokens>0),
    max_tokens INTEGER NOT NULL CHECK(max_tokens>0)
  ) STRICT`
})

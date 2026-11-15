import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/** A run token counts the times its successor was replaced by a renewal asked again. */
export const capabilityReplacements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE capability_tokens ADD COLUMN replaced INTEGER NOT NULL DEFAULT 0`
})

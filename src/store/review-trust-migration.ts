import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export const automaticReviewTrustMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE pull_requests ADD COLUMN author_association TEXT`
  yield* sql`ALTER TABLE pull_requests ADD COLUMN automatic_review_skip_reason TEXT`
})

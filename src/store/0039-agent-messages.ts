import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export const agentMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    message_json TEXT NOT NULL CHECK(json_valid(message_json)),
    target_json TEXT NOT NULL CHECK(json_valid(target_json)),
    origin_host TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK(delivery IN ('pending','queued','delivered','unsupported','unavailable','stale_binding','uncertain')),
    started INTEGER NOT NULL DEFAULT 0 CHECK(started IN (0,1)),
    accepted_at TEXT NOT NULL
  ) STRICT`
  yield* sql`CREATE INDEX agent_messages_pending ON agent_messages(delivery)`
})

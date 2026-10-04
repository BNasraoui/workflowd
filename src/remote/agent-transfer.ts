import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunRefusalError } from "../kernel/agent-run-ingress"
import type { AgentFragment } from "./agent-contract"

export const initAgentTransfers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS remote_agent_fragments (
    transfer_id TEXT NOT NULL, part INTEGER NOT NULL, count INTEGER NOT NULL,
    digest TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (transfer_id, part)
  ) STRICT`
  yield* sql`CREATE TABLE IF NOT EXISTS remote_agent_outbox (
    id TEXT PRIMARY KEY NOT NULL, envelope TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0
  ) STRICT`
})

export const receiveAgentFragment = <S extends Schema.Top>(fragment: AgentFragment, schema: S) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      part: number
      count: number
      digest: string
      data: string
    }>`SELECT part, count, digest, data
      FROM remote_agent_fragments WHERE transfer_id = ${fragment.transferId} ORDER BY part`
    if (
      fragment.index >= fragment.count ||
      rows.some(
        (row) =>
          row.count !== fragment.count ||
          row.digest !== fragment.digest ||
          (row.part === fragment.index && row.data !== fragment.data),
      )
    )
      return yield* new AgentRunRefusalError({
        reason: "run_conflict",
        detail: "conflicting remote transfer",
      })
    yield* sql`INSERT INTO remote_agent_fragments (transfer_id,part,count,digest,data)
      VALUES (${fragment.transferId},${fragment.index},${fragment.count},${fragment.digest},${fragment.data}) ON CONFLICT DO NOTHING`
    const parts = yield* sql<{ data: string }>`SELECT data FROM remote_agent_fragments
      WHERE transfer_id = ${fragment.transferId} ORDER BY part`
    if (parts.length !== fragment.count) return null
    const bytes = Buffer.concat(parts.map((part) => Buffer.from(part.data, "base64")))
    if (createHash("sha256").update(bytes).digest("hex") !== fragment.digest)
      return yield* new AgentRunRefusalError({
        reason: "run_conflict",
        detail: "remote transfer digest mismatch",
      })
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(bytes.toString("utf8"))
  })

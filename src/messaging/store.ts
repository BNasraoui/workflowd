import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { canonicalJson } from "../kernel/session-store-support"
import {
  AgentMessage,
  MessageRecord,
  MessagingError,
  messagingError,
  type DeliveryState,
} from "./contract"
import type { AgentRecipient } from "../directory/contract"

const Row = Schema.Struct({
  message_json: Schema.fromJsonString(AgentMessage),
  target_json: Schema.fromJsonString(MessageRecord.fields.target),
  origin_host: Schema.String,
  delivery: MessageRecord.fields.delivery,
  started: Schema.Literals([0, 1]),
  accepted_at: Schema.String,
})
const decode = (row: unknown) =>
  Schema.decodeUnknownEffect(Row)(row).pipe(
    Effect.map((value): MessageRecord => ({
      message: value.message_json,
      target: value.target_json,
      originHost: value.origin_host,
      delivery: value.delivery,
      started: value.started === 1,
      acceptedAt: value.accepted_at,
    })),
  )
export const makeMessageStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const read = Effect.fn("MessageStore.read")(
    function* (id: string) {
      const rows = yield* sql`SELECT * FROM agent_messages WHERE id=${id}`
      return rows.length === 0 ? null : yield* decode(rows[0])
    },
    (effect) => effect.pipe(Effect.mapError(messagingError)),
  )
  const accept = Effect.fn("MessageStore.accept")(
    function* (message: AgentMessage, target: AgentRecipient, originHost: string) {
      const rows =
        yield* sql`INSERT INTO agent_messages(id,message_json,target_json,origin_host,delivery,accepted_at)
      VALUES(${message.id},${canonicalJson(message)},${canonicalJson(target)},${originHost},'pending',${new Date().toISOString()}) ON CONFLICT DO NOTHING RETURNING id`
      const current = yield* read(message.id)
      if (
        current === null ||
        canonicalJson(current.message) !== canonicalJson(message) ||
        current.originHost !== originHost ||
        canonicalJson(current.target) !== canonicalJson(target)
      )
        return yield* Effect.fail(new MessagingError({ reason: "conflict" }))
      return {
        id: message.id,
        status: rows.length === 1 ? ("accepted" as const) : ("duplicate" as const),
        delivery: current.delivery,
      }
    },
    (effect) => effect.pipe(sql.withTransaction, Effect.mapError(messagingError)),
  )
  const pending = Effect.fn("MessageStore.pending")(function* (
    afterId?: string,
    hostId?: string,
    remote = false,
  ) {
    const rows =
      yield* sql`SELECT * FROM agent_messages WHERE delivery IN ('pending','queued','uncertain')
          AND rowid > COALESCE((SELECT rowid FROM agent_messages WHERE id=${afterId ?? null}),0)
          AND (${hostId ?? null} IS NULL OR (json_extract(target_json,'$.hostId')=${hostId ?? null}) <> ${remote ? 1 : 0})
          ORDER BY rowid LIMIT 100`.pipe(Effect.mapError(messagingError))
    return yield* Effect.forEach(rows, decode).pipe(Effect.mapError(messagingError))
  })
  // Compare-and-set before crossing a non-idempotent native/relay seam. A crash
  // after this write leaves a queryable intent; it never grants a second send.
  const begin = Effect.fn("MessageStore.begin")(
    function* (id: string) {
      const rows =
        yield* sql`UPDATE agent_messages SET started=1 WHERE id=${id} AND started=0 AND delivery='pending' RETURNING id`
      return rows.length === 1
    },
    (effect) => effect.pipe(Effect.mapError(messagingError)),
  )
  const update = Effect.fn("MessageStore.update")(
    function* (id: string, delivery: DeliveryState) {
      yield* sql`UPDATE agent_messages SET delivery=${delivery} WHERE id=${id} AND (${delivery} <> 'pending') AND (delivery IN ('pending','queued') OR (delivery='uncertain' AND ${delivery}='delivered'))`
    },
    (effect) => effect.pipe(Effect.mapError(messagingError)),
  )
  return { read, accept, pending, begin, update }
})

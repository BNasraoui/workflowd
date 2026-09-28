import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
export const ResidentThread = Schema.Struct({
  run_id: Schema.String,
  thread_id: Schema.String,
  directory: Schema.String,
  model: Schema.NullOr(Schema.String),
  state: Schema.Literals(["active", "waiting", "finished", "operator_required"]),
  current_turn: Schema.NullOr(Schema.String),
  wait_turn: Schema.NullOr(Schema.String),
  wait_repo: Schema.NullOr(Schema.String),
  wait_sha: Schema.NullOr(Schema.String),
  wait_deadline: Schema.NullOr(Schema.Number),
})
const Inbox = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  prompt: Schema.String,
  state: Schema.Literals(["prepared", "sending", "delivered", "operator_required"]),
})
export const makeResidentStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const attach = Effect.fn("Resident.attach")(function* (
    runId: string,
    threadId: string,
    directory: string,
    model: string | null,
  ) {
    yield* sql`INSERT INTO resident_threads(run_id,thread_id,directory,model,state) VALUES(${runId},${threadId},${directory},${model},'active')`
  })
  const threads = Effect.fn("Resident.threads")(function* () {
    const rows =
      yield* sql`SELECT * FROM resident_threads WHERE state IN ('active','waiting') ORDER BY run_id`
    return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(ResidentThread)(row))
  })
  const read = Effect.fn("Resident.read")(function* (threadId: string) {
    const rows = yield* sql`SELECT * FROM resident_threads WHERE thread_id = ${threadId}`
    return rows.length === 0 ? null : yield* Schema.decodeUnknownEffect(ResidentThread)(rows[0])
  })
  const started = Effect.fn("Resident.started")(function* (threadId: string, turnId: string) {
    yield* sql`UPDATE resident_threads SET current_turn = ${turnId}, state = 'active' WHERE thread_id = ${threadId} AND state IN ('active','waiting')`
  })
  const park = Effect.fn("Resident.park")(function* (threadId: string) {
    const rows = yield* sql`UPDATE resident_threads SET state = 'waiting', wait_turn = current_turn
      WHERE thread_id = ${threadId} AND state IN ('active','waiting') AND current_turn IS NOT NULL RETURNING thread_id`
    if (rows.length !== 1) return yield* Effect.fail(new Error("Resident thread is not active"))
  })
  const completed = Effect.fn("Resident.completed")(function* (threadId: string, turnId: string) {
    const row = yield* read(threadId)
    if (row === null) return "unknown" as const
    if (row.wait_turn === turnId) return "waiting" as const
    if (row.current_turn !== turnId) return "stale" as const
    const outstanding = yield* sql`SELECT w.wait_id FROM kernel_waits w
      JOIN kernel_workflow_instances i ON i.instance_id = w.instance_id
      WHERE i.workflow_type = 'mailbox_subscription' AND i.workflow_key = ${threadId}
        AND w.state IN ('pending','matched') LIMIT 1`
    if (outstanding.length > 0) {
      yield* park(threadId)
      return "waiting" as const
    }
    yield* sql`UPDATE resident_threads SET state = 'finished' WHERE thread_id = ${threadId}`
    return "finished" as const
  })
  const enqueue = Effect.fn("Resident.enqueue")(function* (
    id: string,
    threadId: string,
    prompt: string,
  ) {
    yield* sql`INSERT INTO resident_inbox(id,thread_id,prompt,state) VALUES(${id},${threadId},${prompt},'prepared') ON CONFLICT(id) DO NOTHING`
  })
  const pending = Effect.fn("Resident.pending")(function* () {
    const rows =
      yield* sql`SELECT * FROM resident_inbox WHERE state IN ('prepared','sending') ORDER BY rowid LIMIT 100`
    return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(Inbox)(row))
  })
  const deliveryState = Effect.fn("Resident.deliveryState")(function* (id: string) {
    const rows = yield* sql`SELECT state FROM resident_inbox WHERE id = ${id}`
    return rows.length === 0
      ? ("pending" as const)
      : yield* Schema.decodeUnknownEffect(Inbox.fields.state)(rows[0]?.state)
  })
  const sending = Effect.fn("Resident.sending")(function* (id: string) {
    yield* sql`UPDATE resident_inbox SET state = 'sending' WHERE id = ${id} AND state = 'prepared'`
  })
  const delivered = Effect.fn("Resident.delivered")(function* (id: string) {
    yield* sql`UPDATE resident_inbox SET state = 'delivered' WHERE id = ${id}`
  })
  const uncertain = Effect.fn("Resident.uncertain")(function* (id: string, threadId: string) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE resident_inbox SET state = 'operator_required' WHERE id = ${id}`
        yield* sql`UPDATE resident_threads SET state = 'operator_required' WHERE thread_id = ${threadId}`
      }),
    )
  })
  return {
    park,
    attach,
    threads,
    read,
    started,
    completed,
    enqueue,
    pending,
    deliveryState,
    sending,
    delivered,
    uncertain,
  }
})

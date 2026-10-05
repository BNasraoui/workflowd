import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxPolicy } from "./config"
import { SandboxTransport } from "./transport"

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  message: Schema.String,
}) {}

const Lease = Schema.Struct({
  run_id: Schema.String,
  lease_id: Schema.String,
  policy: Schema.fromJsonString(SandboxPolicy),
  source_sha: Schema.String,
  state: Schema.Literals([
    "requested",
    "starting",
    "ready",
    "releasing",
    "released",
    "operator_required",
  ]),
  actions_run_id: Schema.NullOr(Schema.Int),
  actions_attempt: Schema.NullOr(Schema.Int),
  peer_id: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(Schema.fromJsonString(SandboxTransport)),
  session_id: Schema.NullOr(Schema.String),
  unit: Schema.NullOr(Schema.String),
  invocation: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  heartbeat_at: Schema.Number,
  deadline: Schema.Number,
  release_error: Schema.NullOr(Schema.String),
})

export const makeSandboxStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const read = Effect.fn("SandboxStore.read")(function* (runId: string) {
    const rows = yield* sql`SELECT * FROM sandbox_leases WHERE run_id=${runId}`
    return rows.length === 0 ? null : yield* Schema.decodeUnknownEffect(Lease)(rows[0])
  })
  const request = Effect.fn("SandboxStore.request")(function* (input: {
    runId: string
    leaseId: string
    policy: SandboxPolicy
    sourceSha: string
    now: number
  }) {
    const policy = yield* Schema.encodeEffect(Schema.fromJsonString(SandboxPolicy))(input.policy)
    yield* Schema.decodeUnknownEffect(SandboxPolicy.fields.workflowSha)(input.sourceSha)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO sandbox_leases(run_id,lease_id,policy,source_sha,state,created_at,heartbeat_at,deadline)
        VALUES(${input.runId},${input.leaseId},${policy},${input.sourceSha},'requested',${input.now},${input.now},${input.now + 285 * 60000})
        ON CONFLICT(run_id) DO NOTHING`
        const row = yield* read(input.runId)
        if (
          row === null ||
          JSON.stringify(row.policy) !== policy ||
          row.source_sha !== input.sourceSha
        )
          return yield* Effect.fail(
            new SandboxError({ message: "Sandbox intent conflicts with existing run" }),
          )
        return row
      }),
    )
  })
  const confirmReleased = Effect.fn("SandboxStore.confirmReleased")(function* (runId: string) {
    const rows = yield* sql`UPDATE sandbox_leases SET state='released',release_error=NULL
      WHERE run_id=${runId} AND state='releasing' RETURNING run_id`
    if (rows.length !== 1)
      return yield* Effect.fail(new SandboxError({ message: "Sandbox is not releasing" }))
  })
  const beginStart = Effect.fn("SandboxStore.beginStart")(function* (runId: string) {
    const rows =
      yield* sql`UPDATE sandbox_leases SET state='starting' WHERE run_id=${runId} AND state='requested' RETURNING run_id`
    return rows.length === 1
  })
  const recordRun = Effect.fn("SandboxStore.recordRun")(function* (
    runId: string,
    actionsRunId: number,
    attempt: number,
  ) {
    const rows =
      yield* sql`UPDATE sandbox_leases SET actions_run_id=${actionsRunId},actions_attempt=${attempt}
      WHERE run_id=${runId} AND state IN ('starting','releasing')
      AND (actions_run_id IS NULL OR (actions_run_id=${actionsRunId} AND actions_attempt=${attempt})) RETURNING run_id`
    if (rows.length !== 1)
      return yield* Effect.fail(new SandboxError({ message: "Sandbox run custody changed" }))
  })
  const beginRelease = Effect.fn("SandboxStore.beginRelease")(function* (runId: string) {
    yield* sql`UPDATE sandbox_leases SET state='releasing' WHERE run_id=${runId} AND state != 'released'`
  })
  const active = Effect.fn("SandboxStore.active")(function* () {
    const rows =
      yield* sql`SELECT * FROM sandbox_leases WHERE state != 'released' ORDER BY created_at`
    return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(Lease)(row))
  })
  const recordError = Effect.fn("SandboxStore.recordError")(function* (runId: string) {
    yield* sql`UPDATE sandbox_leases SET release_error='Sandbox reconciliation failed; retry required' WHERE run_id=${runId} AND state != 'released'`
  })
  const bind = Effect.fn("SandboxStore.bind")(function* (
    runId: string,
    actionsRunId: number,
    attempt: number,
    transport: SandboxTransport,
  ) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SandboxTransport))(transport)
    const rows =
      yield* sql`UPDATE sandbox_leases SET state='ready',peer_id=${transport.peerId},transport=${encoded}
      WHERE run_id=${runId} AND lease_id=${transport.leaseId} AND state='starting' AND actions_run_id=${actionsRunId} AND actions_attempt=${attempt} RETURNING run_id`
    if (rows.length !== 1)
      return yield* Effect.fail(
        new SandboxError({ message: "Sandbox lease changed before peer binding" }),
      )
  })
  return {
    read,
    request,
    confirmReleased,
    beginStart,
    recordRun,
    beginRelease,
    active,
    recordError,
    bind,
  }
})

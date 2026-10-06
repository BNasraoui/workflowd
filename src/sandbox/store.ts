import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxPolicy } from "./config"
import { SandboxTransport } from "./transport"
import type { OwnedLeaseRun } from "./github"

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

const CleanupRun = Schema.Struct({
  repository_id: Schema.Int.check(Schema.isGreaterThan(0)),
  actions_run_id: Schema.Int.check(Schema.isGreaterThan(0)),
  actions_attempt: Schema.Literal(1),
  lease_id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  policy: Schema.fromJsonString(SandboxPolicy),
  state: Schema.Literals(["pending", "terminated", "released"]),
  observed_at: Schema.Number,
  updated_at: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
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
      WHERE run_id=${runId} AND state='releasing'
      AND EXISTS (SELECT 1 FROM sandbox_cleanup_runs c WHERE c.lease_id=sandbox_leases.lease_id AND c.repository_id=json_extract(sandbox_leases.policy,'$.repositoryId'))
      AND NOT EXISTS (SELECT 1 FROM sandbox_cleanup_runs c WHERE c.lease_id=sandbox_leases.lease_id AND c.repository_id=json_extract(sandbox_leases.policy,'$.repositoryId') AND c.state != 'released') RETURNING run_id`
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
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE sandbox_leases SET actions_run_id=${actionsRunId},actions_attempt=${attempt}
        WHERE run_id=${runId} AND state IN ('starting','releasing')
        AND (actions_run_id IS NULL OR (actions_run_id=${actionsRunId} AND actions_attempt=${attempt})) RETURNING *`
        if (rows.length !== 1)
          return yield* Effect.fail(new SandboxError({ message: "Sandbox run custody changed" }))
        const lease = yield* Schema.decodeUnknownEffect(Lease)(rows[0])
        yield* adopt(
          lease.policy,
          { leaseId: lease.lease_id, run: { id: actionsRunId, run_attempt: attempt } },
          Date.now(),
        )
      }),
    )
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
    yield* sql`UPDATE sandbox_leases SET release_error='Sandbox reconciliation failed; retry required' WHERE run_id=${runId}`
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
  const adopt = Effect.fn("SandboxStore.adopt")(function* (
    policy: SandboxPolicy,
    owned: { leaseId: string; run: Pick<OwnedLeaseRun["run"], "id" | "run_attempt"> },
    now: number,
  ) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SandboxPolicy))(policy)
    yield* Schema.decodeUnknownEffect(CleanupRun.fields.actions_run_id)(owned.run.id)
    yield* Schema.decodeUnknownEffect(CleanupRun.fields.actions_attempt)(owned.run.run_attempt)
    yield* Schema.decodeUnknownEffect(CleanupRun.fields.lease_id)(owned.leaseId)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted =
          yield* sql`INSERT INTO sandbox_cleanup_runs(repository_id,actions_run_id,actions_attempt,lease_id,policy,state,observed_at,updated_at)
        VALUES(${policy.repositoryId},${owned.run.id},${owned.run.run_attempt},${owned.leaseId},${encoded},'pending',${now},${now})
        ON CONFLICT(repository_id,actions_run_id,actions_attempt) DO NOTHING RETURNING actions_run_id`
        const rows =
          yield* sql`SELECT * FROM sandbox_cleanup_runs WHERE repository_id=${policy.repositoryId}
        AND actions_run_id=${owned.run.id} AND actions_attempt=${owned.run.run_attempt}`
        const saved = yield* Schema.decodeUnknownEffect(CleanupRun)(rows[0])
        const leases = yield* sql`SELECT policy FROM sandbox_leases WHERE lease_id=${owned.leaseId}
        AND json_extract(policy,'$.repositoryId')=${policy.repositoryId}`
        if (
          saved.lease_id !== owned.leaseId ||
          JSON.stringify(saved.policy) !== encoded ||
          leases.some((lease) => lease.policy !== encoded)
        )
          return yield* Effect.fail(
            new SandboxError({ message: "Sandbox cleanup conflicts with saved custody" }),
          )
        if (inserted.length > 0)
          yield* sql`UPDATE sandbox_leases SET state='releasing'
            WHERE lease_id=${owned.leaseId} AND json_extract(policy,'$.repositoryId')=${policy.repositoryId}
            AND state='released'`
      }),
    )
  })
  const adoptAll = (policy: SandboxPolicy, owned: ReadonlyArray<OwnedLeaseRun>) =>
    sql.withTransaction(
      Effect.forEach(owned, (run) => adopt(policy, run, Date.now()), { discard: true }),
    )
  const cleanupRuns = Effect.fn("SandboxStore.cleanupRuns")(function* () {
    const rows = yield* sql`SELECT * FROM sandbox_cleanup_runs WHERE state != 'released'
      ORDER BY repository_id,lease_id,actions_run_id,actions_attempt`
    return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(CleanupRun)(row))
  })
  const cleanupLease = Effect.fn("SandboxStore.cleanupLease")(function* (
    row: typeof CleanupRun.Type,
  ) {
    const rows = yield* sql`SELECT * FROM sandbox_leases WHERE lease_id=${row.lease_id}
      AND json_extract(policy,'$.repositoryId')=${row.repository_id}`
    return rows.length === 0 ? null : yield* Schema.decodeUnknownEffect(Lease)(rows[0])
  })
  const cleanupState = Effect.fn("SandboxStore.cleanupState")(function* (
    row: typeof CleanupRun.Type,
    state: "pending" | "terminated",
    error: string | null = null,
  ) {
    yield* sql`UPDATE sandbox_cleanup_runs SET state=${state},last_error=${error},updated_at=${Date.now()}
      WHERE repository_id=${row.repository_id} AND actions_run_id=${row.actions_run_id}
      AND actions_attempt=${row.actions_attempt} AND state != 'released'`
  })
  const inventoryError = Effect.fn("SandboxStore.inventoryError")(function* (
    policy: SandboxPolicy,
  ) {
    yield* sql`UPDATE sandbox_cleanup_runs SET last_error='Sandbox inventory incomplete; retry required',updated_at=${Date.now()}
      WHERE repository_id=${policy.repositoryId} AND state != 'released'`
    yield* sql`UPDATE sandbox_leases SET release_error='Sandbox inventory incomplete; retry required'
      WHERE json_extract(policy,'$.repositoryId')=${policy.repositoryId} AND state != 'released'`
  })
  const finishCleanup = Effect.fn("SandboxStore.finishCleanup")(function* <E>(
    row: typeof CleanupRun.Type,
    removeRef: Effect.Effect<void, E>,
  ) {
    // Take the SQLite write fence before checking custody. Keep it until the
    // bounded ref deletion is confirmed, so concurrent adoption cannot pass
    // between the all-terminated check and the external deletion.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE sandbox_cleanup_runs SET updated_at=updated_at
        WHERE repository_id=${row.repository_id} AND lease_id=${row.lease_id}`
        const saved = yield* sql`SELECT state FROM sandbox_cleanup_runs
        WHERE repository_id=${row.repository_id} AND lease_id=${row.lease_id}`
        if (
          saved.length === 0 ||
          saved.some((run) => run.state === "pending") ||
          saved.every((run) => run.state === "released")
        )
          return
        const lease = yield* cleanupLease(row)
        if (lease !== null && lease.state !== "releasing" && lease.state !== "released") return
        yield* removeRef
        yield* sql`UPDATE sandbox_cleanup_runs SET state='released',last_error=NULL,updated_at=${Date.now()}
        WHERE repository_id=${row.repository_id} AND lease_id=${row.lease_id}`
        if (lease?.state === "releasing") yield* confirmReleased(lease.run_id)
      }),
    )
  })
  const attachUnit = Effect.fn("SandboxStore.attachUnit")(function* (
    runId: string,
    unit: string,
    invocation: string,
  ) {
    const rows =
      yield* sql`UPDATE sandbox_leases SET unit=${unit},invocation=${invocation} WHERE run_id=${runId} AND state='ready' AND unit IS NULL RETURNING run_id`
    if (rows.length !== 1)
      return yield* Effect.fail(new SandboxError({ message: "Sandbox process custody changed" }))
  })
  const attachSession = Effect.fn("SandboxStore.attachSession")(function* (
    runId: string,
    sessionId: string,
  ) {
    const rows =
      yield* sql`UPDATE sandbox_leases SET session_id=${sessionId} WHERE run_id=${runId} AND state IN ('requested','starting','ready')
      AND (session_id IS NULL OR session_id=${sessionId})
      AND NOT EXISTS (SELECT 1 FROM sandbox_leases other WHERE other.session_id=${sessionId} AND other.run_id != ${runId}) RETURNING run_id`
    if (rows.length !== 1)
      return yield* Effect.fail(new SandboxError({ message: "Sandbox session custody changed" }))
  })
  const bySession = Effect.fn("SandboxStore.bySession")(function* (sessionId: string) {
    const rows = yield* sql`SELECT * FROM sandbox_leases WHERE session_id=${sessionId}`
    return rows.length === 0 ? null : yield* Schema.decodeUnknownEffect(Lease)(rows[0])
  })
  const heartbeat = Effect.fn("SandboxStore.heartbeat")(function* (runId: string, now: number) {
    yield* sql`UPDATE sandbox_leases SET heartbeat_at=${now} WHERE run_id=${runId} AND state='ready'`
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
    adopt,
    adoptAll,
    cleanupRuns,
    cleanupLease,
    cleanupState,
    inventoryError,
    finishCleanup,
    attachUnit,
    attachSession,
    bySession,
    heartbeat,
  }
})

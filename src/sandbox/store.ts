import { randomUUID } from "node:crypto"
import { Cause, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { SandboxPolicy } from "./config"
import { SandboxTransport } from "./transport"
import type { OwnedLeaseRun } from "./github"

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  message: Schema.String,
  uncertain: Schema.optionalKey(Schema.Boolean),
}) {}

export const sessionCleanupUnconfirmed = "Sandbox session cleanup unconfirmed; retry required"
const unobservedRun = "Sandbox Actions run unobserved; custody retained."
export const isUnobservedRun = (lease: { release_error: string | null }) =>
  lease.release_error?.startsWith(unobservedRun) === true

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

const Operation = Schema.Struct({
  generation: Schema.Int,
  creation_pending: Schema.Literals([0, 1]),
})
type LeaseOperation = {
  repositoryId: number
  leaseId: string
  owner: string
  generation: number
  creationPending: boolean
}

export const makeSandboxStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const currentOperation = (operation: LeaseOperation, checkGeneration = true) =>
    sql`SELECT 1 FROM sandbox_lease_operations
      WHERE repository_id=${operation.repositoryId} AND lease_id=${operation.leaseId}
      AND owner=${operation.owner} AND expires_at>${Date.now()}
      AND (${checkGeneration ? 1 : 0}=0 OR generation=${operation.generation})`.pipe(
      Effect.map((rows) => rows.length === 1),
    )
  const confirmCreation = (operation: LeaseOperation) =>
    sql`UPDATE sandbox_lease_operations SET creation_pending=0
      WHERE repository_id=${operation.repositoryId} AND lease_id=${operation.leaseId}
      AND owner=${operation.owner} AND expires_at>${Date.now()}`
  const withOperation = Effect.fn("SandboxStore.withOperation")(function* <E, E2, E3>(
    repositoryId: number,
    leaseId: string,
    eligible: Effect.Effect<boolean, E>,
    confirmRef: Effect.Effect<void, E3>,
    use: (operation: LeaseOperation) => Effect.Effect<void, E2>,
  ) {
    // The owner serializes external operations for just this lease. Custody
    // mutations advance generation without blocking adoption or other leases.
    const claim = sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* eligible)) return null
        const owner = randomUUID()
        yield* sql`INSERT INTO sandbox_lease_operations(repository_id,lease_id)
        VALUES(${repositoryId},${leaseId}) ON CONFLICT DO NOTHING`
        const rows = yield* sql`UPDATE sandbox_lease_operations
        SET owner=${owner},expires_at=${Date.now() + 10 * 60000},generation=generation+1
        WHERE repository_id=${repositoryId} AND lease_id=${leaseId}
        AND (owner IS NULL OR expires_at<=${Date.now()}) RETURNING generation,creation_pending`
        if (rows.length === 0) return null
        const { generation, creation_pending } = yield* Schema.decodeUnknownEffect(Operation)(
          rows[0],
        )
        return { repositoryId, leaseId, owner, generation, creationPending: creation_pending === 1 }
      }),
    )
    yield* Effect.acquireUseRelease(
      claim,
      // Expiry permits reconciliation, not another creation or release. A
      // disconnected POST may still execute: require its exact ref to appear.
      (operation) =>
        operation === null
          ? Effect.void
          : Effect.gen(function* () {
              if (operation.creationPending) {
                yield* confirmRef
                yield* confirmCreation(operation)
              }
              yield* use(operation)
            }).pipe(Effect.timeout("9 minutes")),
      (operation, exit) =>
        operation === null ||
        (exit._tag === "Failure" &&
          exit.cause.reasons.some(
            (reason) =>
              reason._tag !== "Fail" ||
              Cause.isTimeoutError(reason.error) ||
              (reason.error instanceof SandboxError && reason.error.uncertain === true),
          ))
          ? Effect.void
          : sql`UPDATE sandbox_lease_operations SET owner=NULL,expires_at=NULL
          WHERE repository_id=${repositoryId} AND lease_id=${leaseId} AND owner=${operation.owner}
          AND creation_pending=0`.pipe(Effect.orDie),
    )
  })
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
      AND NOT EXISTS (SELECT 1 FROM sandbox_lease_operations o WHERE o.lease_id=sandbox_leases.lease_id
        AND o.repository_id=json_extract(sandbox_leases.policy,'$.repositoryId') AND o.creation_pending=1)
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
    const rows =
      yield* sql`UPDATE sandbox_leases SET state='releasing' WHERE run_id=${runId} AND state != 'released'
      AND coalesce(release_error,'') != ${sessionCleanupUnconfirmed} RETURNING run_id`
    if (rows.length === 0 && (yield* read(runId))?.state !== "released")
      return yield* Effect.fail(
        new SandboxError({ message: "Sandbox local cleanup must be confirmed before release" }),
      )
  })
  const reconcileUnobserved = Effect.fn("SandboxStore.reconcileUnobserved")(function* <E>(
    runId: string,
    discoverRuns: Effect.Effect<void, E>,
    removeRef: Effect.Effect<void, E>,
    confirmRef: Effect.Effect<void, E>,
  ) {
    const lease = yield* read(runId)
    if (lease === null) return
    const eligible = Effect.gen(function* () {
      const saved = yield* read(runId)
      if (saved?.state !== "releasing" || saved.actions_run_id !== null) return false
      const runs = yield* sql`SELECT 1 FROM sandbox_cleanup_runs WHERE lease_id=${lease.lease_id}
        AND repository_id=${lease.policy.repositoryId}`
      return runs.length === 0
    })
    yield* withOperation(
      lease.policy.repositoryId,
      lease.lease_id,
      eligible,
      confirmRef,
      (operation) =>
        Effect.gen(function* () {
          const result = yield* Effect.gen(function* () {
            yield* discoverRuns
            const remove = yield* sql.withTransaction(
              Effect.gen(function* () {
                return (yield* currentOperation(operation)) && (yield* eligible)
              }),
            )
            if (!remove) return
            yield* removeRef
            // A queued push can become visible after deletion; retain that identity.
            yield* discoverRuns
          }).pipe(Effect.result)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (!(yield* currentOperation(operation)) || !(yield* eligible)) return
              const confirmation =
                result._tag === "Success"
                  ? "Exact ref absence confirmed; empty inventory does not prove run termination."
                  : "Exact ref absence or run inventory unconfirmed; retry reconciliation."
              const diagnostic = `${unobservedRun} ${confirmation} Inspect ${lease.policy.repository} refs/heads/workflowd/leases/${lease.lease_id} at ${lease.policy.workflowSha} in Actions; restore API visibility and reconcile any delayed run. Do not discard custody.`
              yield* sql`UPDATE sandbox_leases SET state='operator_required',release_error=${diagnostic} WHERE run_id=${runId}`
            }),
          )
        }),
    )
  })
  const withAcquisition = Effect.fn("SandboxStore.withAcquisition")(function* <E, E2>(
    runId: string,
    ensureRef: (create: boolean) => Effect.Effect<void, E2>,
    use: (
      commit: <A, E2>(
        effect: Effect.Effect<A, E2>,
      ) => Effect.Effect<A, E2 | SandboxError | SqlError>,
    ) => Effect.Effect<void, E>,
  ) {
    const lease = yield* read(runId)
    if (lease === null) return
    yield* withOperation(
      lease.policy.repositoryId,
      lease.lease_id,
      read(runId).pipe(Effect.map((saved) => saved?.state === "starting")),
      ensureRef(false),
      (operation) =>
        Effect.gen(function* () {
          if (!operation.creationPending) {
            // Persist before any creation can leave the process. Interruption,
            // transport failure or crash must not authorize another POST.
            const marked = yield* sql`UPDATE sandbox_lease_operations SET creation_pending=1
              WHERE repository_id=${operation.repositoryId} AND lease_id=${operation.leaseId}
              AND owner=${operation.owner} AND expires_at>${Date.now()} RETURNING owner`
            if (marked.length !== 1)
              return yield* Effect.fail(
                new SandboxError({ message: "Sandbox acquisition operation changed" }),
              )
            yield* ensureRef(true)
            yield* confirmCreation(operation)
          }
          yield* use((effect) =>
            sql.withTransaction(
              Effect.gen(function* () {
                if (!(yield* currentOperation(operation, false)))
                  return yield* Effect.fail(
                    new SandboxError({ message: "Sandbox acquisition operation changed" }),
                  )
                return yield* effect
              }),
            ),
          )
        }),
    )
  })

  const active = Effect.fn("SandboxStore.active")(function* () {
    const rows =
      yield* sql`SELECT * FROM sandbox_leases WHERE state != 'released' ORDER BY created_at`
    return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(Lease)(row))
  })
  const recordError = Effect.fn("SandboxStore.recordError")(function* (runId: string) {
    yield* sql`UPDATE sandbox_leases SET release_error='Sandbox reconciliation failed; retry required' WHERE run_id=${runId}
      AND coalesce(release_error,'') != ${sessionCleanupUnconfirmed} AND state != 'operator_required'`
  })
  const sessionCleanupError = Effect.fn("SandboxStore.sessionCleanupError")(function* (
    runId: string,
  ) {
    yield* sql`UPDATE sandbox_leases SET state=CASE WHEN state='released' THEN state ELSE 'operator_required' END,
      release_error=${sessionCleanupUnconfirmed} WHERE run_id=${runId}`
  })
  const sessionCleanupConfirmed = Effect.fn("SandboxStore.sessionCleanupConfirmed")(function* (
    runId: string,
  ) {
    yield* sql`UPDATE sandbox_leases SET release_error=NULL WHERE run_id=${runId}
      AND release_error=${sessionCleanupUnconfirmed}`
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
  const cleanupRuns = Effect.fn("SandboxStore.cleanupRuns")(function* (includeReleased = false) {
    const rows =
      yield* sql`SELECT * FROM sandbox_cleanup_runs WHERE ${includeReleased ? 1 : 0}=1 OR state != 'released'
      ORDER BY repository_id,lease_id,actions_run_id,actions_attempt`
    return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(CleanupRun)(row))
  })
  const reopenReleased = Effect.fn("SandboxStore.reopenReleased")(function* (
    policy: SandboxPolicy,
  ) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SandboxPolicy))(policy)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE sandbox_cleanup_runs SET state='pending',updated_at=${Date.now()},last_error='Sandbox custody revalidation pending'
        WHERE policy=${encoded} AND state='released'`
        yield* sql`UPDATE sandbox_leases SET state='releasing',release_error='Sandbox custody revalidation pending'
        WHERE policy=${encoded} AND state='released'`
      }),
    )
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
      WHERE json_extract(policy,'$.repositoryId')=${policy.repositoryId} AND state != 'released'
      AND coalesce(release_error,'') != ${sessionCleanupUnconfirmed} AND state != 'operator_required'`
  })
  const clearPolicyErrors = Effect.fn("SandboxStore.clearPolicyErrors")(function* (
    policy: SandboxPolicy,
  ) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SandboxPolicy))(policy)
    yield* sql`UPDATE sandbox_cleanup_runs SET last_error=NULL WHERE policy=${encoded}`
    yield* sql`UPDATE sandbox_leases SET release_error=NULL WHERE policy=${encoded}
      AND release_error != ${sessionCleanupUnconfirmed} AND state != 'operator_required'`
  })
  const finishCleanup = Effect.fn("SandboxStore.finishCleanup")(function* <E>(
    row: typeof CleanupRun.Type,
    removeRef: Effect.Effect<void, E>,
    confirmRef: Effect.Effect<void, E>,
  ) {
    const eligible = Effect.gen(function* () {
      const saved = yield* sql`SELECT state FROM sandbox_cleanup_runs
        WHERE repository_id=${row.repository_id} AND lease_id=${row.lease_id}`
      if (
        saved.length === 0 ||
        saved.some((run) => run.state === "pending") ||
        saved.every((run) => run.state === "released")
      )
        return false
      const lease = yield* cleanupLease(row)
      return lease === null || lease.state === "releasing" || lease.state === "released"
    })
    yield* withOperation(row.repository_id, row.lease_id, eligible, confirmRef, (operation) =>
      Effect.gen(function* () {
        yield* removeRef
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* currentOperation(operation)) || !(yield* eligible)) return
            yield* sql`UPDATE sandbox_cleanup_runs SET state='released',last_error=NULL,updated_at=${Date.now()}
            WHERE repository_id=${row.repository_id} AND lease_id=${row.lease_id}`
            const lease = yield* cleanupLease(row)
            if (lease?.state === "releasing") yield* confirmReleased(lease.run_id)
          }),
        )
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
    withAcquisition,
    recordRun,
    beginRelease,
    reconcileUnobserved,
    active,
    recordError,
    sessionCleanupError,
    sessionCleanupConfirmed,
    bind,
    adopt,
    adoptAll,
    cleanupRuns,
    reopenReleased,
    cleanupLease,
    cleanupState,
    inventoryError,
    clearPolicyErrors,
    finishCleanup,
    attachUnit,
    attachSession,
    bySession,
    heartbeat,
  }
})

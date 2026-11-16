import { createConnection } from "node:net"
import { Effect, Queue, Schema, Semaphore, Struct } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  CapabilityGrant,
  ControlAnswer,
  RunBudget,
  controlFrame,
  controlProtocol,
  maxControlFrame,
  type ControlVerb,
  type ControlVerbSchemas,
} from "../capability-control/protocol"
import { runLifetime } from "../store/run-lifetime"
import { authorizeWorker } from "../worker-identity/access"
import { defaultRunBudget } from "./config"

/** The gateway did not answer: its socket is missing, refused the connection, or timed out. */
export class CapabilityGatewayUnavailable extends Schema.TaggedError<CapabilityGatewayUnavailable>()(
  "CapabilityGatewayUnavailable",
  { reason: Schema.String },
) {}
/** The gateway answered with a refusal, or workflowd has no live run to grant. */
export class CapabilityControlRefused extends Schema.TaggedError<CapabilityControlRefused>()(
  "CapabilityControlRefused",
  { reason: Schema.String },
) {}

/** The time limit of one call on the control socket, with its wait for a permit where it takes one. */
const withinCallLimit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("15 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new CapabilityGatewayUnavailable({ reason: "timed out" })),
    ),
  )

/** One request on the control socket and its answer, within the time limit of a call. */
const send = <A, I, B, O>(
  socket: string,
  verb: ControlVerb,
  entry: ControlVerbSchemas<A, I, B, O>,
  request: A,
) =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(entry.request)(request).pipe(
      Effect.mapError(() => new CapabilityControlRefused({ reason: "body" })),
    )
    const text = yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<string>((resolve, reject) => {
          const connection = createConnection(socket)
          let answer = Buffer.alloc(0)
          const complete = () => answer.length >= 4 && answer.readUInt32BE(0) === answer.length - 4
          // A complete answer stands, whatever the connection does after it: the gateway answers
          // a refused caller before it reads the request, so the request's write can fail.
          const fail = (error: unknown) => {
            connection.destroy()
            if (complete()) resolve(answer.subarray(4).toString("utf8"))
            else reject(error instanceof Error ? error : new Error(String(error)))
          }
          signal.addEventListener("abort", () => fail(new Error("aborted")))
          connection.setTimeout(10000, () => fail(new Error("control socket timed out")))
          connection.on("error", fail)
          connection.on("connect", () => connection.write(controlFrame({ verb, body })))
          connection.on("data", (chunk) => {
            answer = Buffer.concat([answer, Buffer.from(chunk)])
            if (answer.length > maxControlFrame + 4) fail(new Error("control answer too long"))
          })
          connection.on("end", () => {
            if (!complete()) return fail(new Error("control answer cut short"))
            resolve(answer.subarray(4).toString("utf8"))
          })
        }),
      catch: (cause) =>
        new CapabilityGatewayUnavailable({
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(withinCallLimit)
    const answer = yield* Schema.decodeUnknownEffect(ControlAnswer)(text).pipe(
      Effect.mapError(() => new CapabilityGatewayUnavailable({ reason: "unreadable answer" })),
    )
    if (!answer.ok)
      return yield* answer.error === "unavailable"
        ? Effect.fail(new CapabilityGatewayUnavailable({ reason: answer.error }))
        : Effect.fail(new CapabilityControlRefused({ reason: answer.error }))
    return yield* Schema.decodeUnknownEffect(entry.response)(answer.value).pipe(
      Effect.mapError(() => new CapabilityGatewayUnavailable({ reason: "unreadable answer" })),
    )
  })

/** workflowd's calls on the control socket at `socket`, one for each verb. */
export const controlClient = (socket: string) => ({
  authorize: (grant: CapabilityGrant) =>
    send(socket, "authorize", controlProtocol.authorize, { grant }),
  revoke: (runId: string) => send(socket, "revoke", controlProtocol.revoke, { runId }),
  reconcile: (live: ReadonlyArray<CapabilityGrant>) =>
    send(socket, "reconcile", controlProtocol.reconcile, { live }),
  sessionBound: (runId: string, actionsRunId: number, actionsAttempt: number) =>
    send(socket, "sessionBound", controlProtocol.sessionBound, {
      runId,
      actionsRunId,
      actionsAttempt,
    }),
  usage: (runId: string) => send(socket, "usage", controlProtocol.usage, { runId }),
})

/** A grant as workflowd's store holds it before its budget is fixed. */
const UnbudgetedGrant = Schema.Struct(Struct.omit(CapabilityGrant.fields, ["budget"]))

/** workflowd's worker authorization ends a run's authority this long after the run was made. */
const workerLifetimeMs = 86400000

/**
 * The grant of each live native run in workflowd's store, or of `runId` alone: a run that
 * workflowd's worker authorization admits, whose lease is starting or ready with its Actions run
 * recorded and before its deadline. A run's budget is `budget` the first time the run is granted,
 * and the budget stored then each later time.
 */
export const liveGrants = Effect.fn("DaemonCapability.liveGrants")(function* (
  runId: string | null,
  now: number,
  budget: RunBudget,
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<Record<string, unknown>>`SELECT a.run_id AS runId,l.lease_id AS leaseId,
      d.recipient_id AS recipientId,a.attempt,a.repository,a.provider_id AS providerId,
      a.model_id AS modelId,a.state,a.created_at AS createdAt,
      json_extract(l.policy,'$.repositoryId') AS repositoryId,l.source_sha AS sourceSha,
      json_extract(l.policy,'$.repository') AS repositoryName,
      json_extract(l.policy,'$.installationId') AS installationId,
      l.actions_run_id AS actionsRunId,l.actions_attempt AS actionsAttempt,l.deadline,l.policy
      FROM kernel_agent_runs a JOIN sandbox_leases l ON l.run_id=a.run_id
      JOIN directory_managed d ON d.run_id=a.run_id
      WHERE a.repository=json_extract(l.policy,'$.alias')
      AND json_extract(l.policy,'$.privateBootstrap.mode')='actions-native'
      AND l.state IN ('starting','ready') AND l.actions_run_id IS NOT NULL
      AND (${runId} IS NULL OR a.run_id=${runId})`
  const live: CapabilityGrant[] = []
  for (const { state, createdAt, policy, ...row } of rows) {
    const created = new Date(String(createdAt))
    if (!authorizeWorker({ state: String(state), createdAt: created }, now)) continue
    const parsed: unknown = JSON.parse(String(policy))
    const grant = yield* Schema.decodeUnknownEffect(UnbudgetedGrant)({
      ...row,
      policy: parsed,
      notAfter: created.getTime() + workerLifetimeMs,
    })
    if (grant.deadline > now)
      live.push({ ...grant, budget: yield* fixedBudget(grant.runId, budget) })
  }
  return live
})

/** The budget stored for `runId`; `budget` is stored first when the run has none. */
const fixedBudget = Effect.fn("DaemonCapability.fixedBudget")(function* (
  runId: string,
  budget: RunBudget,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO capability_run_budgets(run_id,calls,output_tokens,max_tokens)
    VALUES(${runId},${budget.calls},${budget.outputTokens},${budget.maxTokens})
    ON CONFLICT(run_id) DO NOTHING`
  const rows = yield* sql`SELECT calls,output_tokens AS outputTokens,max_tokens AS maxTokens
    FROM capability_run_budgets WHERE run_id=${runId}`
  return yield* Schema.decodeUnknownEffect(RunBudget)(rows[0])
})

/**
 * workflowd's side of the gateway. It computes each run's grant from workflowd's own store and
 * sends it on the control socket; the gateway never reads that store.
 *
 * - `authorize` grants a live native run whose lease has recorded its Actions run.
 * - Each change of a granted run's lifetime (its state, its attempt, its lease's release) is
 *   followed once the change commits: a run that is no longer live is revoked, at once.
 * - `reconcile` sends every live run, so the gateway revokes the others; it runs at start and
 *   every `reconcileEveryMs`, which also covers a revoke that the gateway missed while it was down.
 */
export const makeDaemonCapability = (options: {
  readonly socket: string
  readonly reconcileEveryMs?: number
  /** The budget of a run that workflowd authorizes for the first time. */
  readonly budget?: RunBudget
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lifetime = runLifetime(sql)
    const control = controlClient(options.socket)
    const scope = yield* Effect.scope
    const calls = yield* Semaphore.make(1)
    // `authorize`, `revoke` and `reconcile` take one permit each; the wait for it counts toward
    // the time limit of the call.
    const permitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withinCallLimit(calls.withPermits(1)(effect))
    const watched = new Map<string, () => void>()
    const changed = yield* Queue.unbounded<string>()
    const grants = (runId: string | null) =>
      liveGrants(runId, Date.now(), options.budget ?? defaultRunBudget).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      )
    const watch = (runId: string) => {
      if (!watched.has(runId))
        watched.set(
          runId,
          lifetime.listen(runId, () => Queue.offerUnsafe(changed, runId)),
        )
    }
    const unwatch = (runId: string) => {
      watched.get(runId)?.()
      watched.delete(runId)
    }
    const revoke = Effect.fn("DaemonCapability.revoke")(function* (runId: string) {
      yield* permitted(control.revoke(runId))
      unwatch(runId)
    })
    const authorize = Effect.fn("DaemonCapability.authorize")(function* (runId: string) {
      const [grant] = yield* grants(runId)
      if (grant === undefined)
        return yield* Effect.fail(new CapabilityControlRefused({ reason: "run is not live" }))
      watch(runId)
      yield* permitted(control.authorize(grant))
    })
    const reconcile = Effect.fn("DaemonCapability.reconcile")(function* () {
      yield* permitted(
        Effect.gen(function* () {
          // The live set is read under the same permit as each grant, so no grant sent after it
          // can be revoked by it.
          const live = yield* grants(null)
          for (const grant of live) watch(grant.runId)
          yield* control.reconcile(live)
          for (const runId of watched.keys())
            if (!live.some((grant) => grant.runId === runId)) unwatch(runId)
        }),
      )
    })
    const sessionBound = Effect.fn("DaemonCapability.sessionBound")(
      (runId: string, actionsRunId: number, actionsAttempt: number) =>
        control.sessionBound(runId, actionsRunId, actionsAttempt),
    )
    /**
     * Starts the revoke of `runId` and returns at once. The revoke ends in this client's scope,
     * within the time limit of a call; a failure is logged, and the next reconcile, which names
     * only live runs, revokes the run.
     */
    const startRevoke = Effect.fn("DaemonCapability.startRevoke")(function* (runId: string) {
      yield* revoke(runId).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Capability gateway revoke unconfirmed for ${runId}; the next reconcile revokes it: ${error.reason}`,
          ),
        ),
        Effect.forkIn(scope),
      )
    })
    // A change notifies inside its transaction; this read waits for it to commit or roll back.
    yield* Queue.take(changed).pipe(
      Effect.flatMap((runId) =>
        grants(runId).pipe(
          Effect.flatMap((live) => (live.length === 0 ? revoke(runId) : authorize(runId))),
          Effect.ignore,
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
    yield* reconcile().pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep(options.reconcileEveryMs ?? 10000)),
      Effect.forever,
      Effect.forkScoped,
    )
    /** What the run spent of its budget, and whether the budget is spent. */
    const usage = Effect.fn("DaemonCapability.usage")((runId: string) => control.usage(runId))
    return { authorize, revoke, reconcile, sessionBound, startRevoke, usage }
  })
export type DaemonCapability = Effect.Success<ReturnType<typeof makeDaemonCapability>>

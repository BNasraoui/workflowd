import { createConnection } from "node:net"
import { Effect, Queue, Schema, Semaphore, Struct } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  CapabilityGrant,
  ControlAnswer,
  RunBudget,
  controlFrame,
  controlProtocol,
  maxControlConnections,
  maxControlFrame,
  type ControlVerb,
  type ControlVerbSchemas,
} from "../capability-control/protocol"
import { runLifetime } from "../store/run-lifetime"
import { ScopedKeyedLock } from "../workspace/locks"
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

/** The time limit of one call on the control socket, with its waits for its turn where it has one. */
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
  readEvents: (runId: string, after: number) =>
    send(socket, "readEvents", controlProtocol.readEvents, { runId, after }),
  readResult: (runId: string, offset: number) =>
    send(socket, "readResult", controlProtocol.readResult, { runId, offset }),
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
  /** The repository aliases placed on a runner: each run of one carries its launch. */
  runnerAliases: ReadonlyArray<string> = [],
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<Record<string, unknown>>`SELECT a.run_id AS runId,l.lease_id AS leaseId,
      d.recipient_id AS recipientId,a.attempt,a.repository,a.provider_id AS providerId,
      a.model_id AS modelId,a.state,a.created_at AS createdAt,
      json_extract(l.policy,'$.repositoryId') AS repositoryId,l.source_sha AS sourceSha,
      json_extract(l.policy,'$.repository') AS repositoryName,
      json_extract(l.policy,'$.installationId') AS installationId,
      l.actions_run_id AS actionsRunId,l.actions_attempt AS actionsAttempt,l.deadline,l.policy,
      a.prompt AS prompt,json_extract(l.policy,'$.agentImage') AS image
      FROM kernel_agent_runs a JOIN sandbox_leases l ON l.run_id=a.run_id
      JOIN directory_managed d ON d.run_id=a.run_id
      WHERE a.repository=json_extract(l.policy,'$.alias')
      AND json_extract(l.policy,'$.privateBootstrap.mode')='actions-native'
      AND l.state IN ('starting','ready') AND l.actions_run_id IS NOT NULL
      AND (${runId} IS NULL OR a.run_id=${runId})`
  const live: CapabilityGrant[] = []
  for (const { state, createdAt, policy, prompt, image, ...row } of rows) {
    const created = new Date(String(createdAt))
    if (!authorizeWorker({ state: String(state), createdAt: created }, now)) continue
    const parsed: unknown = JSON.parse(String(policy))
    const grant = yield* Schema.decodeUnknownEffect(UnbudgetedGrant)({
      ...row,
      ...(runnerAliases.includes(String(row.repository)) ? { launch: { prompt, image } } : {}),
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
  yield* sql`INSERT INTO sandbox_run_budgets(run_id,calls,output_tokens,max_tokens)
    VALUES(${runId},${budget.calls},${budget.outputTokens},${budget.maxTokens})
    ON CONFLICT(run_id) DO NOTHING`
  const rows = yield* sql`SELECT calls,output_tokens AS outputTokens,max_tokens AS maxTokens
    FROM sandbox_run_budgets WHERE run_id=${runId}`
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
 *
 * The calls of one run reach the gateway one at a time, in the order they start, so a run's
 * authorize comes before its revoke; the calls of different runs do not wait for each other.
 */
export const makeDaemonCapability = (options: {
  readonly socket: string
  readonly reconcileEveryMs?: number
  /** The budget of a run that workflowd authorizes for the first time. */
  readonly budget?: RunBudget
  /** The repository aliases placed on a runner; each grant of their runs carries its launch. */
  readonly runnerAliases?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const lifetime = runLifetime(sql)
    const control = controlClient(options.socket)
    const scope = yield* Effect.scope
    // The runs with a call in flight or waiting; a run leaves when its last call ends.
    const runs = new ScopedKeyedLock()
    // The places of the daemon's connections at the gateway: each connection holds one, so the
    // client never opens more than the gateway accepts. A reconcile holds them all, so no grant
    // reaches the gateway between its read of the live runs and the gateway's answer, which would
    // revoke a run granted after that read. A call that needs one place passes a reconcile that
    // waits for all of them. So a call of a run waits for the calls of its own run, for a
    // reconcile in flight, and, while every place is taken, for a place.
    const places = yield* Semaphore.make(maxControlConnections)
    const placed = places.withPermits(1)
    /** `effect` as a call of `runId`: after the calls of that run that started before it. */
    const ofRun =
      (runId: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        withinCallLimit(Effect.scoped(Effect.andThen(runs.acquire(runId), effect)))
    const watched = new Map<string, () => void>()
    const changed = yield* Queue.unbounded<string>()
    const grants = (runId: string | null) =>
      liveGrants(runId, Date.now(), options.budget ?? defaultRunBudget, options.runnerAliases).pipe(
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
    // The revoke and the authorize of a run, in its turn.
    const revokeRun = (runId: string) =>
      placed(control.revoke(runId)).pipe(Effect.tap(() => Effect.sync(() => unwatch(runId))))
    const authorizeRun = Effect.fnUntraced(function* (runId: string) {
      const [grant] = yield* grants(runId)
      if (grant === undefined)
        return yield* Effect.fail(new CapabilityControlRefused({ reason: "run is not live" }))
      watch(runId)
      yield* placed(control.authorize(grant))
    })
    const revoke = Effect.fn("DaemonCapability.revoke")((runId: string) =>
      ofRun(runId)(revokeRun(runId)),
    )
    const authorize = Effect.fn("DaemonCapability.authorize")((runId: string) =>
      ofRun(runId)(authorizeRun(runId)),
    )
    const reconcile = Effect.fn("DaemonCapability.reconcile")(function* () {
      yield* withinCallLimit(
        places.withPermits(maxControlConnections)(
          Effect.gen(function* () {
            // The live set is read while the reconcile holds every place, so no grant sent after
            // the read can be revoked by it.
            const live = yield* grants(null)
            for (const grant of live) watch(grant.runId)
            yield* control.reconcile(live)
            for (const runId of watched.keys())
              if (!live.some((grant) => grant.runId === runId)) unwatch(runId)
          }),
        ),
      )
    })
    const sessionBound = Effect.fn("DaemonCapability.sessionBound")(
      (runId: string, actionsRunId: number, actionsAttempt: number) =>
        ofRun(runId)(placed(control.sessionBound(runId, actionsRunId, actionsAttempt))),
    )
    /**
     * Starts the revoke of `runId` and returns at once. The revoke ends in this client's scope,
     * within the time limit of a call. A revoke that fails, or that the end of the scope (a stop
     * of the daemon) interrupts, is logged with its cause, and the next reconcile, which names
     * only live runs, revokes the run: after a stop, the reconcile at the next start.
     */
    const startRevoke = Effect.fn("DaemonCapability.startRevoke")(function* (runId: string) {
      const unconfirmed = (cause: string) =>
        Effect.logWarning(
          `Capability gateway revoke unconfirmed for ${runId}; the next reconcile revokes it: ${cause}`,
        )
      yield* revoke(runId).pipe(
        Effect.catch((error) => unconfirmed(error.reason)),
        Effect.onInterrupt(() => unconfirmed("interrupted")),
        Effect.forkIn(scope),
      )
    })
    // A change notifies inside its transaction; this read waits for it to commit or roll back.
    // Each change is followed in its run's turn, on a fiber of its own, so the change of one run
    // does not wait for the calls of another.
    yield* Queue.take(changed).pipe(
      Effect.flatMap((runId) =>
        ofRun(runId)(
          grants(runId).pipe(
            Effect.flatMap((live) => (live.length === 0 ? revokeRun(runId) : authorizeRun(runId))),
          ),
        ).pipe(Effect.ignore, Effect.forkIn(scope)),
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
    /** A runner run's event batches after `after`, its result's presence and the gateway's end. */
    const readEvents = Effect.fn("DaemonCapability.readEvents")((runId: string, after: number) =>
      ofRun(runId)(placed(control.readEvents(runId, after))),
    )
    /** The part at `offset` of a runner run's result. */
    const readResult = Effect.fn("DaemonCapability.readResult")((runId: string, offset: number) =>
      ofRun(runId)(placed(control.readResult(runId, offset))),
    )
    return {
      authorize,
      revoke,
      reconcile,
      sessionBound,
      startRevoke,
      readEvents,
      readResult,
      /** The runs that have a call in flight or waiting for its turn. */
      runsWithCalls: () => runs.size,
    }
  })
export type DaemonCapability = Effect.Success<ReturnType<typeof makeDaemonCapability>>

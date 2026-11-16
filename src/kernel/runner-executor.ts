import { createHash } from "node:crypto"
import { Data, Deferred, Effect, Option, Stream } from "effect"
import { boxReadyLine } from "../../deploy/sandbox/box-ready.mjs"
import type { EventBatch, GatewayEnd } from "../capability-control/protocol"
import { parseClaudeDispatchEvent } from "./claude-dispatch"
import type { CliEvent } from "./cli-process-contract"
import type { Executor, ExecutorLaunch } from "./executor"
import { decodeSealedResult, type SealedResult, type SealedResultRefused } from "./sealed-result"

/**
 * The executor of the `runner` placement: a GitHub Actions job that opens a gateway session and
 * posts its events and its one sealed result to the gateway. The daemon reads both on the
 * gateway's control socket; nothing of the run reaches the daemon any other way.
 */

/**
 * Why a runner run ended without a result that the daemon can check. The ends of a live run are
 * `cancelled` (its stop), `runner_deadline`, `runner_lost` (no post for `lostAfterMs` while its
 * Actions run goes on), `runner_cancelled` and `runner_failed` (its Actions run ended with no
 * result, by its conclusion), and `gateway_ended`.
 */
export type RunnerFailure =
  | "runner_capacity"
  | "runner_start"
  | "cancelled"
  | "runner_deadline"
  | "runner_lost"
  | "runner_cancelled"
  | "runner_failed"
  | "gateway_ended"
  | "result_format"
  | "gateway_unavailable"

export class RunnerRunFailed extends Data.TaggedError("RunnerRunFailed")<{
  readonly reason: RunnerFailure
  readonly message: string
}> {}

/** The gateway's control verbs that the executor uses. */
export type RunnerGateway = {
  readonly readEvents: (
    runId: string,
    after: number,
  ) => Effect.Effect<
    {
      readonly batches: ReadonlyArray<EventBatch>
      readonly result: boolean
      readonly ended: GatewayEnd | null
    },
    { readonly _tag: string }
  >
  readonly readResult: (
    runId: string,
    offset: number,
  ) => Effect.Effect<
    { readonly size: number; readonly sha256: string; readonly part: string },
    { readonly _tag: string }
  >
  readonly revoke: (runId: string) => Effect.Effect<void, { readonly _tag: string }>
}

/** The Actions run of a runner run's job, as GitHub reports it. */
type RunnerJobState = { readonly status: string; readonly conclusion: string | null }

/** One runner run as the executor holds it. */
export type RunnerHandle = {
  readonly runId: string
  readonly deadline: number
  /** The gateway's own end of the run, once the events show it. */
  ended: GatewayEnd | null
  /** Set by the run's stop; the run's events then end `cancelled`. */
  stopping: boolean
  /** When the daemon last read a new batch of the run, or started the run. */
  lastPost: number
  /** When the daemon last read the run's Actions run. */
  jobReadAt: number
  /** Done once the run's first event line, the line of its ready box, is read. */
  readonly boxReady: Deferred.Deferred<void>
}

/** The text of the gateway's end of a run, with the counts that it used. */
export const gatewayEndText = (ended: GatewayEnd) =>
  `ended: ${ended.reason} (${ended.calls} calls, ${ended.outputTokens} output tokens)`

/** The pause between two reads of a run's events when the last read gave none. */
const pollMs = 2000
/**
 * The time with no post after which a run whose Actions run goes on is lost. The run client posts
 * an empty batch after 10 s with no post, so a live runner is never quiet this long.
 */
const lostAfterMs = 120000
/** The pause between two reads of a run's Actions run while its posts come. */
const jobEveryMs = 30000

const gatewayUnavailable = (cause: { readonly _tag: string }) =>
  new RunnerRunFailed({ reason: "gateway_unavailable", message: `gateway: ${cause._tag}` })

/**
 * Splits the result body as the run posted it: the 4-byte big-endian length of result.json,
 * result.json, then result.bundle, which is empty when the run changed nothing.
 */
const framedResult = (body: Buffer) => {
  if (body.length < 4) return undefined
  const length = body.readUInt32BE(0)
  if (length === 0 || 4 + length > body.length) return undefined
  return { json: body.subarray(4, 4 + length), bundle: body.subarray(4 + length) }
}

export const makeRunnerExecutor = (options: {
  readonly gateway: RunnerGateway
  /** The runner runs at one time; a further start is refused `runner_capacity`. */
  readonly maxRuns: number
  /**
   * Creates the run's lease, whose ref starts the job; the job then opens its session. `stopped`
   * tells whether the run's stop came, which ends the wait for the session.
   */
  readonly begin: (
    launch: ExecutorLaunch,
    stopped: () => boolean,
  ) => Effect.Effect<void, RunnerRunFailed>
  /** The Actions run of the run's job, or null while none is known or it cannot be read. */
  readonly job?: (runId: string) => Effect.Effect<RunnerJobState | null>
}) => {
  const live = new Set<string>()
  /** The runs whose stop came; a stop before the start ends the start. */
  const stopped = new Set<string>()
  const handles = new Map<string, RunnerHandle>()
  const start = (launch: ExecutorLaunch) =>
    Effect.suspend(() => {
      if (!live.has(launch.runId) && live.size >= options.maxRuns)
        return Effect.fail(
          new RunnerRunFailed({
            reason: "runner_capacity",
            message: `${live.size} runner runs are live; the bound is ${options.maxRuns}`,
          }),
        )
      live.add(launch.runId)
      return options
        .begin(launch, () => stopped.has(launch.runId))
        .pipe(
          Effect.onError(() => Effect.sync(() => live.delete(launch.runId))),
          Effect.map(() => {
            const started = Date.now()
            const handle: RunnerHandle = {
              runId: launch.runId,
              deadline: launch.deadline.getTime(),
              ended: null,
              stopping: stopped.has(launch.runId),
              lastPost: started,
              jobReadAt: started,
              boxReady: Deferred.makeUnsafe<void>(),
            }
            handles.set(launch.runId, handle)
            return handle
          }),
        )
    })
  /**
   * The run's Actions run when it is due: each `jobEveryMs`, and at once when the run is quiet for
   * `lostAfterMs`. Undefined when not due, null when unknown.
   */
  const jobOf = (handle: RunnerHandle, quiet: boolean) =>
    Effect.suspend(() => {
      if (options.job === undefined || (!quiet && Date.now() - handle.jobReadAt < jobEveryMs))
        return Effect.succeed(undefined)
      handle.jobReadAt = Date.now()
      return options.job(handle.runId)
    })
  const ending = (reason: RunnerFailure, message: string) =>
    Effect.fail(new RunnerRunFailed({ reason, message }))
  /**
   * The run's events in order: its first line, which must be the line of its ready box
   * (`boxReadyLine`; another first line ends the run `runner_start`), marks `boxReady` done; each
   * later line of each batch is a Claude stream-json line. The stream
   * ends once the gateway holds the result and every batch is read, or with the run's end. When
   * two ends come at one read, the first of this order wins: the stop (`cancelled`), the gateway's
   * own end, the run's deadline, its Actions run's conclusion (`runner_cancelled`,
   * `runner_failed`), then `runner_lost`. A result that the gateway holds wins over all but the
   * stop and the gateway's end. A run ends once, so a cause that comes later changes nothing.
   */
  const events = (handle: RunnerHandle): Stream.Stream<CliEvent, RunnerRunFailed> =>
    Stream.paginate(0, (after: number) =>
      Effect.gen(function* () {
        if (handle.stopping) return yield* ending("cancelled", "the run was stopped")
        const read = yield* options.gateway.readEvents(handle.runId, after).pipe(
          Effect.mapError(gatewayUnavailable),
          // A stop during the read revokes the run, so the read may fail: the stop still wins.
          Effect.catch((error) =>
            handle.stopping ? ending("cancelled", "the run was stopped") : Effect.fail(error),
          ),
        )
        if (handle.stopping) return yield* ending("cancelled", "the run was stopped")
        const last = read.batches.at(-1)?.sequence ?? after
        if (read.batches.length > 0) {
          handle.lastPost = Date.now()
          const lines = read.batches.flatMap((batch) => batch.lines)
          if (!Deferred.isDoneUnsafe(handle.boxReady) && lines.length > 0) {
            if (lines[0] !== boxReadyLine)
              return yield* ending(
                "runner_start",
                "the run's first event is not its box's ready line",
              )
            Deferred.doneUnsafe(handle.boxReady, Effect.void)
            lines.shift()
          }
          return [lines.map(parseClaudeDispatchEvent), Option.some(last)] as const
        }
        if (read.ended !== null) {
          handle.ended = read.ended
          return yield* ending("gateway_ended", gatewayEndText(read.ended))
        }
        if (read.result) return [[], Option.none()] as const
        if (Date.now() >= handle.deadline)
          return yield* ending("runner_deadline", "the run's deadline passed before its result")
        const quiet = Date.now() - handle.lastPost >= lostAfterMs
        const job = yield* jobOf(handle, quiet)
        if (job?.status === "completed") {
          // The job may have posted its last batches and its result after the read above.
          const again = yield* options.gateway
            .readEvents(handle.runId, after)
            .pipe(Effect.mapError(gatewayUnavailable))
          if (again.batches.length > 0 || again.result) return [[], Option.some(after)] as const
          return yield* job.conclusion === "cancelled"
            ? ending("runner_cancelled", "the run's Actions run was cancelled before its result")
            : ending(
                "runner_failed",
                `the run's Actions run ended ${job.conclusion ?? "with no conclusion"} before its result`,
              )
        }
        if (quiet && job !== undefined && job !== null)
          return yield* ending(
            "runner_lost",
            `no post of the run for ${lostAfterMs}ms while its Actions run is ${job.status}`,
          )
        yield* Effect.sleep(pollMs)
        return [[], Option.some(after)] as const
      }),
    )
  /** The run's sealed result: every part, checked against the gateway's SHA-256, then decoded. */
  const result = (handle: RunnerHandle) =>
    Effect.gen(function* () {
      const parts: Array<Buffer> = []
      let offset = 0
      let size = 1
      let sha256 = ""
      while (offset < size) {
        const part = yield* options.gateway
          .readResult(handle.runId, offset)
          .pipe(Effect.mapError(gatewayUnavailable))
        if (offset > 0 && (part.size !== size || part.sha256 !== sha256))
          return yield* new RunnerRunFailed({
            reason: "result_format",
            message: "the result changed while it was read",
          })
        size = part.size
        sha256 = part.sha256
        const bytes = Buffer.from(part.part, "base64")
        if (bytes.length === 0)
          return yield* new RunnerRunFailed({
            reason: "result_format",
            message: "a part of the result is empty",
          })
        parts.push(bytes)
        offset += bytes.length
      }
      const body = Buffer.concat(parts)
      if (body.length !== size || createHash("sha256").update(body).digest("hex") !== sha256)
        return yield* new RunnerRunFailed({
          reason: "result_format",
          message: "the result read is not the result held",
        })
      const framed = framedResult(body)
      if (framed === undefined)
        return yield* new RunnerRunFailed({
          reason: "result_format",
          message: "the result is not framed as the run routes say",
        })
      return yield* decodeSealedResult(framed.json, framed.bundle)
    }) satisfies Effect.Effect<SealedResult, RunnerRunFailed | SealedResultRefused>
  /** Revokes the run in the gateway, which ends its token and its open model streams. */
  const stop = (handle: RunnerHandle) =>
    options.gateway.revoke(handle.runId).pipe(Effect.mapError(gatewayUnavailable))
  return {
    placement: "runner" as const,
    start,
    events,
    stop,
    result,
    /**
     * The caller's stop of the run `runId`: its events end `cancelled`, and the gateway revokes
     * it. A run that is starting ends its start; false when this executor holds no such run.
     */
    stopRun: (runId: string) =>
      Effect.suspend(() => {
        if (!live.has(runId)) return Effect.succeed(false)
        stopped.add(runId)
        const handle = handles.get(runId)
        if (handle !== undefined) handle.stopping = true
        return options.gateway
          .revoke(runId)
          .pipe(Effect.mapError(gatewayUnavailable), Effect.as(true))
      }),
    /** Ends the executor's hold of a run, so its place among the runs at one time is free. */
    release: (runId: string) => {
      live.delete(runId)
      stopped.delete(runId)
      handles.delete(runId)
    },
  } satisfies Executor<RunnerHandle, RunnerRunFailed | SealedResultRefused> & {
    readonly stopRun: (runId: string) => Effect.Effect<boolean, RunnerRunFailed>
    readonly release: (runId: string) => void
  }
}

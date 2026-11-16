import { createHash } from "node:crypto"
import { Data, Effect, Option, Stream } from "effect"
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

/** Why a runner run ended without a result that the daemon can check. */
export type RunnerFailure =
  | "runner_capacity"
  | "runner_start"
  | "runner_deadline"
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

/** One runner run as the executor holds it. */
export type RunnerHandle = {
  readonly runId: string
  readonly deadline: number
  /** The gateway's own end of the run, once the events show it. */
  ended: GatewayEnd | null
}

/** The text of the gateway's end of a run, with the counts that it used. */
export const gatewayEndText = (ended: GatewayEnd) =>
  `ended: ${ended.reason} (${ended.calls} calls, ${ended.outputTokens} output tokens)`

const gatewayUnavailable = (cause: { readonly _tag: string }) =>
  new RunnerRunFailed({ reason: "gateway_unavailable", message: `gateway: ${cause._tag}` })

/**
 * Splits the result body as the run posted it: the 4-byte big-endian length of result.json,
 * result.json, then result.bundle.
 */
const framedResult = (body: Buffer) => {
  if (body.length < 4) return undefined
  const length = body.readUInt32BE(0)
  if (length === 0 || 4 + length >= body.length) return undefined
  return { json: body.subarray(4, 4 + length), bundle: body.subarray(4 + length) }
}

export const makeRunnerExecutor = (options: {
  readonly gateway: RunnerGateway
  /** The runner runs at one time; a further start is refused `runner_capacity`. */
  readonly maxRuns: number
  /** Creates the run's lease, whose ref starts the job; the job then opens its session. */
  readonly begin: (launch: ExecutorLaunch) => Effect.Effect<void, RunnerRunFailed>
  /** The pause between two reads of a run's events when the last read gave none. */
  readonly pollMs?: number
  readonly now?: () => number
}) => {
  const live = new Set<string>()
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 2000
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
      return options.begin(launch).pipe(
        Effect.onError(() => Effect.sync(() => live.delete(launch.runId))),
        Effect.as<RunnerHandle>({
          runId: launch.runId,
          deadline: launch.deadline.getTime(),
          ended: null,
        }),
      )
    })
  /**
   * The run's events in order: each line of each batch as a Claude stream-json line. The stream
   * ends once the gateway holds the result and every batch is read, or with a failure when the
   * gateway ended the run or its deadline passed first.
   */
  const events = (handle: RunnerHandle): Stream.Stream<CliEvent, RunnerRunFailed> =>
    Stream.paginate(0, (after: number) =>
      Effect.gen(function* () {
        const read = yield* options.gateway
          .readEvents(handle.runId, after)
          .pipe(Effect.mapError(gatewayUnavailable))
        const last = read.batches.at(-1)?.sequence ?? after
        const lines = read.batches.flatMap((batch) => batch.lines)
        const parsed = lines.map(parseClaudeDispatchEvent)
        if (read.batches.length > 0) return [parsed, Option.some(last)] as const
        if (read.ended !== null) {
          handle.ended = read.ended
          return yield* new RunnerRunFailed({
            reason: "gateway_ended",
            message: gatewayEndText(read.ended),
          })
        }
        if (read.result) return [[], Option.none()] as const
        if (now() >= handle.deadline)
          return yield* new RunnerRunFailed({
            reason: "runner_deadline",
            message: "the run's deadline passed before its result",
          })
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
  const stop = (handle: RunnerHandle) =>
    options.gateway.revoke(handle.runId).pipe(Effect.mapError(gatewayUnavailable))
  return {
    placement: "runner" as const,
    start,
    events,
    stop,
    result,
    /** Ends the executor's hold of a run, so its place among the runs at one time is free. */
    release: (runId: string) => {
      live.delete(runId)
    },
  } satisfies Executor<RunnerHandle, RunnerRunFailed | SealedResultRefused> & {
    readonly release: (runId: string) => void
  }
}

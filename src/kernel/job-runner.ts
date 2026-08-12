import { Effect, Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import { KernelJobStore } from "./job-store"

const EchoJobInput = Schema.Struct({
  kind: Schema.Literal("echo"),
  value: JsonValueSchema,
})

export const MAX_KERNEL_JOB_RETRY_DELAY_MS = 60 * 60_000

export type KernelJobIterationOptions = {
  readonly workerId: string
  readonly now: () => Date
  readonly leaseDurationMs: number
  readonly retryDelayMs: number
  readonly execute?: (value: JsonValue) => Effect.Effect<void, Error>
}

export const runKernelJobIteration = (options: KernelJobIterationOptions) =>
  Effect.gen(function* () {
    const jobs = yield* KernelJobStore
    const claim = yield* jobs.claimNext({ ...options, now: options.now() })
    if (claim === null) return { status: "idle" as const }

    const authority = (now: Date) => ({
      ...claim,
      expectedLeaseUntil: claim.leaseUntil,
      now,
    })
    if (claim.inputVersion !== 1) {
      yield* jobs.fail({
        ...authority(options.now()),
        failureVersion: 1,
        failure: { message: `unsupported input version ${claim.inputVersion}` },
        category: "operator_required",
      })
      return { status: "operator_required" as const, jobId: claim.jobId }
    }

    const decoded = yield* Schema.decodeUnknown(EchoJobInput)(claim.input, {
      onExcessProperty: "error",
    }).pipe(Effect.either)
    if (decoded._tag === "Left") {
      yield* jobs.fail({
        ...authority(options.now()),
        failureVersion: 1,
        failure: { message: "unsupported or malformed version-1 job input" },
        category: "operator_required",
      })
      return { status: "operator_required" as const, jobId: claim.jobId }
    }
    const execution = yield* (options.execute?.(decoded.right.value) ?? Effect.void).pipe(
      Effect.either,
    )
    if (execution._tag === "Left") {
      const failedAt = options.now()
      const configuredDelay = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 0
      const retryDelayMs = Math.max(0, Math.min(configuredDelay, MAX_KERNEL_JOB_RETRY_DELAY_MS))
      const runAt = new Date(failedAt.getTime() + retryDelayMs)
      const retried = yield* jobs.retry({
        ...authority(failedAt),
        runAt,
        failureVersion: 1,
        failure: { message: "transient job execution failure" },
      })
      return retried.status === "retry_scheduled"
        ? { status: "retry_scheduled" as const, jobId: claim.jobId, runAt }
        : { status: "failed" as const, jobId: claim.jobId }
    }
    yield* jobs.complete({
      ...authority(options.now()),
      resultId: claim.jobId,
      resultVersion: 1,
      result: decoded.right,
    })
    return { status: "completed" as const, jobId: claim.jobId }
  })

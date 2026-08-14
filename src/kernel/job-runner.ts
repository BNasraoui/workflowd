import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import { WorkSignal } from "../work-signal"
import { ResumeParentAgentJobV1 } from "./agent-handoff-contract"
import { KernelJobStore } from "./job-store"
import { KernelSessionStore } from "./session-store"

const EchoJobInput = Schema.Struct({
  kind: Schema.Literal("echo"),
  value: JsonValueSchema,
})
const VersionOneJobInput = Schema.Union(EchoJobInput, ResumeParentAgentJobV1)

const ParentSessionRow = Schema.Struct({
  session_id: Schema.String,
  owning_host_id: Schema.String,
  state: Schema.Literal("ready", "active"),
})

export const MAX_KERNEL_JOB_RETRY_DELAY_MS = 60 * 60_000

export type KernelJobIterationOptions = {
  readonly workerId: string
  readonly now: () => Date
  readonly leaseDurationMs: number
  readonly retryDelayMs: number
  readonly execute?: (value: JsonValue) => Effect.Effect<void, Error>
  readonly afterResumeRegistered?: () => Effect.Effect<void, Error>
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

    const decoded = yield* Schema.decodeUnknown(VersionOneJobInput)(claim.input, {
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
    if (decoded.right.kind === "resume_parent_agent") {
      const sessionStore = yield* Effect.serviceOption(KernelSessionStore)
      const workSignal = yield* Effect.serviceOption(WorkSignal)
      if (Option.isNone(sessionStore) || Option.isNone(workSignal)) {
        yield* jobs.fail({
          ...authority(options.now()),
          failureVersion: 1,
          failure: { message: "parent resume services are unavailable" },
          category: "operator_required",
        })
        return { status: "operator_required" as const, jobId: claim.jobId }
      }
      const parentUnknown = yield* sessionStore.value.readSession(decoded.right.parentSessionId)
      const parent = yield* Schema.decodeUnknown(ParentSessionRow)(parentUnknown).pipe(
        Effect.either,
      )
      if (parent._tag === "Left" || parent.right.session_id !== decoded.right.parentSessionId) {
        yield* jobs.fail({
          ...authority(options.now()),
          failureVersion: 1,
          failure: { message: "parent session is unavailable or malformed" },
          category: "operator_required",
        })
        return { status: "operator_required" as const, jobId: claim.jobId }
      }
      const registeredAt = new Date(decoded.right.registeredAt)
      yield* sessionStore.value.registerResumeRequest({
        requestId: `${claim.jobId}:request`,
        sessionId: parent.right.session_id,
        owningHostId: parent.right.owning_host_id,
        prompt: decoded.right.resumePrompt,
        promptText: decoded.right.resumePromptText,
        promptSha256: createHash("sha256").update(decoded.right.resumePromptText).digest("hex"),
        outputContract: decoded.right.outputContract,
        outputContractVersion: decoded.right.outputContractVersion,
        maxAttempts: claim.maxAttempts,
        runAt: registeredAt,
        createdAt: registeredAt,
      })
      const postRegistration = yield* (options.afterResumeRegistered?.() ?? Effect.void).pipe(
        Effect.either,
      )
      if (postRegistration._tag === "Left") {
        const failedAt = options.now()
        const configuredDelay = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 0
        const retryDelayMs = Math.max(0, Math.min(configuredDelay, MAX_KERNEL_JOB_RETRY_DELAY_MS))
        const runAt = new Date(failedAt.getTime() + retryDelayMs)
        const retried = yield* jobs.retry({
          ...authority(failedAt),
          runAt,
          failureVersion: 1,
          failure: { message: "transient post-registration handoff failure" },
        })
        return retried.status === "retry_scheduled"
          ? { status: "retry_scheduled" as const, jobId: claim.jobId, runAt }
          : { status: "failed" as const, jobId: claim.jobId }
      }
      yield* workSignal.value.wake("session-resume")
      yield* jobs.complete({
        ...authority(options.now()),
        resultId: claim.jobId,
        resultVersion: 1,
        result: { kind: "resume_parent_agent", requestId: `${claim.jobId}:request` },
      })
      return { status: "completed" as const, jobId: claim.jobId }
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

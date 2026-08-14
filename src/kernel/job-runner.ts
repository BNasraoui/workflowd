import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import { WorkSignal } from "../work-signal"
import {
  ResumeParentAgentJobV1,
  type ResumeParentAgentJobV1 as ResumeParentAgentJob,
} from "./agent-handoff-contract"
import { KernelJobStore, type JobClaim, type KernelJobStorePort } from "./job-store"
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

const claimAuthority = (claim: JobClaim, now: Date) => ({
  ...claim,
  expectedLeaseUntil: claim.leaseUntil,
  now,
})

const failOperatorRequired = (
  jobs: KernelJobStorePort,
  claim: JobClaim,
  now: Date,
  message: string,
) =>
  jobs.fail({
    ...claimAuthority(claim, now),
    failureVersion: 1,
    failure: { message },
    category: "operator_required",
  })

const retryClaim = (
  jobs: KernelJobStorePort,
  claim: JobClaim,
  options: KernelJobIterationOptions,
  message: string,
) =>
  Effect.gen(function* () {
    const failedAt = options.now()
    const configuredDelay = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 0
    const retryDelayMs = Math.max(0, Math.min(configuredDelay, MAX_KERNEL_JOB_RETRY_DELAY_MS))
    const runAt = new Date(failedAt.getTime() + retryDelayMs)
    const retried = yield* jobs.retry({
      ...claimAuthority(claim, failedAt),
      runAt,
      failureVersion: 1,
      failure: { message },
    })
    return retried.status === "retry_scheduled"
      ? { status: "retry_scheduled" as const, jobId: claim.jobId, runAt }
      : { status: "failed" as const, jobId: claim.jobId }
  })

const runParentResumeJob = (
  jobs: KernelJobStorePort,
  claim: JobClaim,
  input: ResumeParentAgentJob,
  options: KernelJobIterationOptions,
) =>
  Effect.gen(function* () {
    const sessionStore = yield* Effect.serviceOption(KernelSessionStore)
    const workSignal = yield* Effect.serviceOption(WorkSignal)
    if (Option.isNone(sessionStore) || Option.isNone(workSignal)) {
      yield* failOperatorRequired(
        jobs,
        claim,
        options.now(),
        "parent resume services are unavailable",
      )
      return { status: "operator_required" as const, jobId: claim.jobId }
    }
    const parentUnknown = yield* sessionStore.value.readSession(input.parentSessionId)
    const parent = yield* Schema.decodeUnknown(ParentSessionRow)(parentUnknown).pipe(Effect.either)
    if (parent._tag === "Left" || parent.right.session_id !== input.parentSessionId) {
      yield* failOperatorRequired(
        jobs,
        claim,
        options.now(),
        "parent session is unavailable or malformed",
      )
      return { status: "operator_required" as const, jobId: claim.jobId }
    }
    const registeredAt = new Date(input.registeredAt)
    yield* sessionStore.value.registerResumeRequest({
      requestId: `${claim.jobId}:request`,
      sessionId: parent.right.session_id,
      owningHostId: parent.right.owning_host_id,
      prompt: input.resumePrompt,
      promptText: input.resumePromptText,
      promptSha256: createHash("sha256").update(input.resumePromptText).digest("hex"),
      outputContract: input.outputContract,
      outputContractVersion: input.outputContractVersion,
      maxAttempts: claim.maxAttempts,
      runAt: registeredAt,
      createdAt: registeredAt,
    })
    const postRegistration = yield* (options.afterResumeRegistered?.() ?? Effect.void).pipe(
      Effect.either,
    )
    if (postRegistration._tag === "Left") {
      return yield* retryClaim(jobs, claim, options, "transient post-registration handoff failure")
    }
    yield* workSignal.value.wake("session-resume")
    yield* jobs.complete({
      ...claimAuthority(claim, options.now()),
      resultId: claim.jobId,
      resultVersion: 1,
      result: { kind: "resume_parent_agent", requestId: `${claim.jobId}:request` },
    })
    return { status: "completed" as const, jobId: claim.jobId }
  })

const runEchoJob = (
  jobs: KernelJobStorePort,
  claim: JobClaim,
  input: typeof EchoJobInput.Type,
  options: KernelJobIterationOptions,
) =>
  Effect.gen(function* () {
    const execution = yield* (options.execute?.(input.value) ?? Effect.void).pipe(Effect.either)
    if (execution._tag === "Left") {
      return yield* retryClaim(jobs, claim, options, "transient job execution failure")
    }
    yield* jobs.complete({
      ...claimAuthority(claim, options.now()),
      resultId: claim.jobId,
      resultVersion: 1,
      result: input,
    })
    return { status: "completed" as const, jobId: claim.jobId }
  })

export const runKernelJobIteration = (options: KernelJobIterationOptions) =>
  Effect.gen(function* () {
    const jobs = yield* KernelJobStore
    const claim = yield* jobs.claimNext({ ...options, now: options.now() })
    if (claim === null) return { status: "idle" as const }

    if (claim.inputVersion !== 1) {
      yield* failOperatorRequired(
        jobs,
        claim,
        options.now(),
        `unsupported input version ${claim.inputVersion}`,
      )
      return { status: "operator_required" as const, jobId: claim.jobId }
    }

    const decoded = yield* Schema.decodeUnknown(VersionOneJobInput)(claim.input, {
      onExcessProperty: "error",
    }).pipe(Effect.either)
    if (decoded._tag === "Left") {
      yield* failOperatorRequired(
        jobs,
        claim,
        options.now(),
        "unsupported or malformed version-1 job input",
      )
      return { status: "operator_required" as const, jobId: claim.jobId }
    }
    return decoded.right.kind === "resume_parent_agent"
      ? yield* runParentResumeJob(jobs, claim, decoded.right, options)
      : yield* runEchoJob(jobs, claim, decoded.right, options)
  })

import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import {
  KernelEventStore,
  type KernelStoreConflictError,
  type KernelStoreDataError,
  type KernelStoreInputError,
} from "../kernel/event-store"
import { KernelJobStore, type KernelJobStoreError } from "../kernel/job-store"
import { ClaudeResumeJobV1, MAX_CLAUDE_RESUME_PROMPT_BYTES } from "./contract"

const RequestId = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)))
const EnqueueInput = Schema.Struct({
  requestId: RequestId,
  attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  payload: ClaudeResumeJobV1,
})

/**
 * The agent-wake prompt is caller-bounded at 32 KiB locally, but a remote
 * delivery must fit the 16 KiB wire envelope. A prompt over the remote
 * budget is refused before anything durable exists — never truncated.
 */
export class ClaudeResumePromptTooLarge extends Data.TaggedError("ClaudeResumePromptTooLarge")<{
  readonly requestId: string
  readonly promptBytes: number
}> {}

export type ClaudeResumeRemoteProducerPort = {
  readonly enqueue: (
    input: typeof EnqueueInput.Type,
    now: Date,
  ) => Effect.Effect<
    { readonly status: "enqueued" | "duplicate"; readonly jobId: string },
    | ClaudeResumePromptTooLarge
    | SqlError
    | KernelStoreConflictError
    | KernelStoreDataError
    | KernelStoreInputError
    | KernelJobStoreError
    | Schema.SchemaError
  >
}

export const ClaudeResumeRemoteProducer = Context.Service<ClaudeResumeRemoteProducerPort>(
  "workflowd/remote/ClaudeResumeRemoteProducer",
)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore
  const jobs = yield* KernelJobStore

  const enqueue: ClaudeResumeRemoteProducerPort["enqueue"] = (input, now) =>
    Effect.gen(function* () {
      const promptBytes = new TextEncoder().encode(input.payload.prompt).byteLength
      if (promptBytes > MAX_CLAUDE_RESUME_PROMPT_BYTES) {
        return yield* new ClaudeResumePromptTooLarge({
          requestId: input.requestId,
          promptBytes,
        })
      }
      const decoded = yield* Schema.decodeUnknownEffect(EnqueueInput)(input, {
        onExcessProperty: "error",
      })
      const identity = `${decoded.requestId}-a${decoded.attempt}`
      const jobId = `claude-resume-remote-${identity}`
      const instanceId = `claude-resume-remote-instance-${identity}`
      const waitId = `claude-resume-remote-wait-${identity}`
      const condition = {
        type: "claude-resume-submitted",
        version: 1,
        key: jobId,
        correlation: jobId,
      } as const
      const instance = yield* events.createInstance({
        instanceId,
        workflowType: "claude-resume-remote",
        workflowVersion: 1,
        workflowKey: jobId,
        payload: { hostId: decoded.payload.hostId },
        createdAt: now,
      })
      const wait = yield* events.registerWait({
        instanceId,
        waitId,
        condition,
        registeredAt: instance.instance.createdAt,
      })
      const event = yield* events.recordEvent({
        source: "claude-resume-remote",
        sourceEventId: `claude-resume-remote-event-${identity}`,
        event: { ...condition, payload: { hostId: decoded.payload.hostId } },
        recordedAt: now,
      })
      const enqueued = yield* jobs.enqueueFromDelivery({
        jobId,
        instanceId,
        waitId,
        eventSequence: event.event.sequence,
        expectedCursor: wait.wait.afterSequence,
        inputVersion: 1,
        input: decoded.payload,
        // Exactly one delivery attempt: a failed or expired wake escalates
        // to the operator rather than re-prompting a session on its own.
        maxAttempts: 1,
        runAt: now,
        createdAt: now,
      })
      return { status: enqueued.status, jobId }
    }).pipe(sql.withTransaction)

  return ClaudeResumeRemoteProducer.of({ enqueue })
})

export const ClaudeResumeRemoteProducerLive = Layer.effect(ClaudeResumeRemoteProducer, make)

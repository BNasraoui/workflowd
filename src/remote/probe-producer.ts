import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Effect, Layer, Schema } from "effect"
import {
  KernelEventStore,
  type KernelStoreConflictError,
  type KernelStoreDataError,
  type KernelStoreInputError,
} from "../kernel/event-store"
import { KernelJobStore, type KernelJobStoreError } from "../kernel/job-store"
import type { ParseResult } from "effect"
import {
  jobCompletionCondition,
  WAIT_FOR_JOB_WORKFLOW_VERSION,
} from "../kernel/job-completion-contract"
import { RemoteHostId } from "./contract"

const ProbeId = Schema.NonEmptyString.pipe(
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
)
const ProbeInput = Schema.Struct({
  probeId: ProbeId,
  hostId: RemoteHostId,
  resume: Schema.optional(
    Schema.Struct({
      provider: Schema.Literal("opencode"),
      sessionId: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
      host: RemoteHostId,
    }),
  ),
})

export type RemoteProbeProducerPort = {
  readonly enqueue: (
    input: typeof ProbeInput.Type,
    now: Date,
  ) => Effect.Effect<
    { readonly status: "enqueued" | "duplicate"; readonly jobId: string },
    | SqlError
    | KernelStoreConflictError
    | KernelStoreDataError
    | KernelStoreInputError
    | KernelJobStoreError
    | ParseResult.ParseError
  >
}

export const RemoteProbeProducer = Context.GenericTag<RemoteProbeProducerPort>(
  "workflowd/remote/RemoteProbeProducer",
)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore
  const jobs = yield* KernelJobStore

  const enqueue: RemoteProbeProducerPort["enqueue"] = (input, now) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(ProbeInput)(input, { onExcessProperty: "error" })
      const jobId = `remote-probe-${decoded.probeId}`
      const instanceId = `remote-probe-instance-${decoded.probeId}`
      const waitId = `remote-probe-wait-${decoded.probeId}`
      const condition = {
        type: "remote-probe-submitted",
        version: 1,
        key: jobId,
        correlation: jobId,
      } as const
      const instance = yield* events.createInstance({
        instanceId,
        workflowType: "remote-probe",
        workflowVersion: 1,
        workflowKey: jobId,
        payload:
          decoded.resume === undefined
            ? { hostId: decoded.hostId }
            : { hostId: decoded.hostId, resume: decoded.resume },
        createdAt: now,
      })
      const wait = yield* events.registerWait({
        instanceId,
        waitId,
        condition,
        registeredAt: instance.instance.createdAt,
      })
      const event = yield* events.recordEvent({
        source: "remote-probe",
        sourceEventId: `remote-probe-event-${decoded.probeId}`,
        event: { ...condition, payload: { hostId: decoded.hostId } },
        recordedAt: now,
      })
      const enqueued = yield* jobs.enqueueFromDelivery({
        jobId,
        instanceId,
        waitId,
        eventSequence: event.event.sequence,
        expectedCursor: wait.wait.afterSequence,
        inputVersion: 1,
        input: { kind: "remote_probe", hostId: decoded.hostId },
        maxAttempts: 3,
        runAt: now,
        createdAt: now,
      })
      if (decoded.resume !== undefined) {
        const resumeInstanceId = `remote-probe-resume-instance-${decoded.probeId}`
        const completion = jobCompletionCondition(jobId)
        const resumeInstance = yield* events.createInstance({
          instanceId: resumeInstanceId,
          workflowType: "wait_for_job",
          workflowVersion: WAIT_FOR_JOB_WORKFLOW_VERSION,
          workflowKey: jobId,
          payload: { kind: "wait_for_job", jobId, ...decoded.resume },
          createdAt: now,
        })
        yield* events.registerWait({
          instanceId: resumeInstanceId,
          waitId: `remote-probe-resume-wait-${decoded.probeId}`,
          condition: completion,
          registeredAt: resumeInstance.instance.createdAt,
        })
      }
      return { status: enqueued.status, jobId }
    }).pipe(sql.withTransaction)

  return RemoteProbeProducer.of({ enqueue })
})

export const RemoteProbeProducerLive = Layer.effect(RemoteProbeProducer, make)

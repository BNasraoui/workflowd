import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Effect, Layer, Schema } from "effect"
import {
  KernelEventStore,
  type KernelStoreConflictError,
  type KernelStoreDataError,
  type KernelStoreInputError,
} from "../kernel/event-store"
import { KernelJobStore, type KernelJobStoreError } from "../kernel/job-store"
import { RemoteHostId } from "./contract"

const ProbeId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)),
)
const ProbeInput = Schema.Struct({ probeId: ProbeId, hostId: RemoteHostId })

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
    | Schema.SchemaError
  >
}

export const RemoteProbeProducer = Context.Service<RemoteProbeProducerPort>(
  "workflowd/remote/RemoteProbeProducer",
)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* KernelEventStore
  const jobs = yield* KernelJobStore

  const enqueue: RemoteProbeProducerPort["enqueue"] = (input, now) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(ProbeInput)(input, {
        onExcessProperty: "error",
      })
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
        payload: { hostId: decoded.hostId },
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
      return { status: enqueued.status, jobId }
    }).pipe(sql.withTransaction)

  return RemoteProbeProducer.of({ enqueue })
})

export const RemoteProbeProducerLive = Layer.effect(RemoteProbeProducer, make)

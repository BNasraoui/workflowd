import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "@effect/sql"
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient"
import { Effect, Layer } from "effect"
import type { JsonValue } from "../../src/json"
import {
  KernelEventStore,
  KernelEventStoreLive,
  type KernelEventStorePort,
} from "../../src/kernel/event-store"
import {
  KernelJobStore,
  KernelJobStoreLive,
  type JobClaim,
  type KernelJobStorePort,
} from "../../src/kernel/job-store"
import { WorkflowStoreLive } from "../../src/store"

export const now = new Date("2026-08-12T10:00:00.000Z")
export const expiry = new Date("2026-08-12T10:01:00.000Z")

export const removeDatabase = async (filename: string) => {
  for (const path of [filename, `${filename}-shm`, `${filename}-wal`]) {
    await Bun.file(path)
      .delete()
      .catch(() => undefined)
  }
}

export const kernelLayer = (filename: string) => {
  const database = SqliteClient.layer({ filename })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  return Layer.merge(KernelEventStoreLive, KernelJobStoreLive).pipe(Layer.provideMerge(bootstrap))
}

export const runKernel = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, KernelEventStorePort | KernelJobStorePort | SqlClientService>,
) => Effect.runPromise(effect.pipe(Effect.provide(kernelLayer(filename))))

export const deliveryInput = (jobId: string, input: JsonValue = { task: "review" }) => ({
  jobId,
  instanceId: `instance-${jobId.slice(0, 100)}`,
  waitId: `wait-${jobId.slice(0, 100)}`,
  eventSequence: 1,
  expectedCursor: 0,
  inputVersion: 1,
  input,
  maxAttempts: 3,
  runAt: now,
  createdAt: now,
})

export const arrangeDelivery = (jobId: string, input: JsonValue = { task: "review" }) =>
  Effect.gen(function* () {
    const events = yield* KernelEventStore
    const sql = yield* SqlClient.SqlClient
    const identifiers = deliveryInput(jobId, input)
    yield* events.createInstance({
      instanceId: identifiers.instanceId,
      workflowType: "test",
      workflowVersion: 1,
      workflowKey: jobId.slice(0, 100),
      payload: null,
      createdAt: now,
    })
    yield* events.registerWait({
      instanceId: identifiers.instanceId,
      waitId: identifiers.waitId,
      condition: {
        type: "signal",
        version: 1,
        key: jobId.slice(0, 100),
        correlation: jobId.slice(0, 100),
      },
      registeredAt: now,
    })
    const recorded = yield* events.recordEvent({
      source: "test",
      sourceEventId: `event-${jobId.slice(0, 100)}`,
      event: {
        type: "signal",
        version: 1,
        key: jobId.slice(0, 100),
        correlation: jobId.slice(0, 100),
        payload: null,
      },
      recordedAt: now,
    })
    const cursor = yield* sql<{ readonly event_cursor: number }>`SELECT event_cursor
      FROM kernel_workflow_instances WHERE instance_id = ${identifiers.instanceId}`
    return {
      ...identifiers,
      eventSequence: recorded.event.sequence,
      expectedCursor: cursor[0]!.event_cursor,
    }
  })

export const arrangeJob = (jobId: string, input: JsonValue = { task: "review" }) =>
  Effect.gen(function* () {
    const jobs = yield* KernelJobStore
    const delivery = yield* arrangeDelivery(jobId, input)
    yield* jobs.enqueueFromDelivery(delivery)
    return delivery
  })

export const claimJob = (jobId: string, workerId = "worker-a", claimedAt = now) =>
  Effect.gen(function* () {
    const jobs = yield* KernelJobStore
    yield* arrangeJob(jobId)
    const claim = yield* jobs.claimNext({
      workerId,
      now: claimedAt,
      leaseDurationMs: 60_000,
    })
    if (claim === null) return yield* Effect.die(new Error(`expected claim for ${jobId}`))
    return claim
  })

export const authority = (claim: JobClaim, at = new Date(now.getTime() + 1_000)) => ({
  jobId: claim.jobId,
  workerId: claim.workerId,
  attempt: claim.attempt,
  claimToken: claim.claimToken,
  expectedLeaseUntil: claim.leaseUntil,
  now: at,
})

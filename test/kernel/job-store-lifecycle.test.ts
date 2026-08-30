import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import { KernelEventStore } from "../../src/kernel/event-store"
import { KernelJobStore } from "../../src/kernel/job-store"
import {
  arrangeDelivery,
  arrangeJob,
  authority,
  claimJob,
  now,
  runKernel,
} from "./job-store-harness"

describe("kernel job creation", () => {
  test("atomically consumes a ready delivery, advances its cursor, and creates one job", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const events = yield* KernelEventStore
        const input = yield* arrangeDelivery("atomic")
        const enqueued = yield* jobs.enqueueFromDelivery(input)
        return {
          enqueued,
          ready: yield* events.readReadyDeliveries(input.instanceId),
          claim: yield* jobs.claimNext({ workerId: "worker", now, leaseDurationMs: 60_000 }),
        }
      }),
    )

    expect(result.enqueued).toMatchObject({ status: "enqueued", eventCursor: 1 })
    expect(result.ready).toEqual([])
    expect(result.claim).toMatchObject({ jobId: "atomic", input: { task: "review" }, attempt: 1 })
  })

  test("rolls back delivery, cursor, and job when an injected job trigger aborts", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const events = yield* KernelEventStore
        const sql = yield* SqlClient.SqlClient
        const input = yield* arrangeDelivery("rollback")
        yield* sql`CREATE TRIGGER reject_kernel_job BEFORE INSERT ON kernel_workflow_jobs
          BEGIN SELECT RAISE(ABORT, 'injected job failure'); END`
        const failed = yield* jobs.enqueueFromDelivery(input).pipe(Effect.result)
        const instance = yield* sql`SELECT event_cursor FROM kernel_workflow_instances
          WHERE instance_id = ${input.instanceId}`
        const rows = yield* sql`SELECT job_id FROM kernel_workflow_jobs`
        return {
          failed,
          instance,
          rows,
          ready: yield* events.readReadyDeliveries(input.instanceId),
        }
      }),
    )

    expect(result.failed._tag).toBe("Failure")
    expect(result.instance).toEqual([{ event_cursor: 0 }])
    expect(result.rows).toEqual([])
    expect(result.ready).toHaveLength(1)
  })

  test("returns an exact enqueue replay and rejects changed durable content", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const input = yield* arrangeDelivery("replay")
        const first = yield* jobs.enqueueFromDelivery(input)
        const exact = yield* jobs.enqueueFromDelivery(input)
        const conflict = yield* jobs
          .enqueueFromDelivery({ ...input, input: { task: "changed" } })
          .pipe(Effect.result)
        return { first, exact, conflict }
      }),
    )

    expect([result.first.status, result.exact.status]).toEqual(["enqueued", "duplicate"])
    expect(result.conflict).toMatchObject({
      _tag: "Failure",
      left: { _tag: "KernelJobStoreConflictError", record: "job", key: "replay" },
    })
  })

  test("fails closed when enqueue replay changes delivery provenance", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const input = yield* arrangeDelivery("provenance")
        yield* jobs.enqueueFromDelivery(input)
        return yield* jobs
          .enqueueFromDelivery({ ...input, expectedCursor: input.expectedCursor + 1 })
          .pipe(Effect.result)
      }),
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      left: { _tag: "KernelJobStoreConflictError", record: "job", key: "provenance" },
    })
  })
})

describe("kernel job outcomes", () => {
  test("honors retry run_at and fails instead of scheduling beyond max attempts", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const first = yield* claimJob("retry")
        const runAt = new Date("2026-08-12T10:05:00.000Z")
        const retried = yield* jobs.retry({
          ...authority(first),
          runAt,
          failureVersion: 1,
          failure: { message: "temporary" },
        })
        const early = yield* jobs.claimNext({
          workerId: "worker-b",
          now: new Date(runAt.getTime() - 1),
          leaseDurationMs: 60_000,
        })
        const second = yield* jobs.claimNext({
          workerId: "worker-b",
          now: runAt,
          leaseDurationMs: 1,
        })
        if (second === null) return yield* Effect.die(new Error("expected retry claim"))
        yield* jobs
          .retry({
            ...authority(second, second.leaseUntil),
            runAt,
            failureVersion: 1,
            failure: { message: "expired authority" },
          })
          .pipe(Effect.ignore)
        const recovered = yield* jobs.claimNext({
          workerId: "worker-c",
          now: second.leaseUntil,
          leaseDurationMs: 60_000,
        })
        if (recovered === null) return yield* Effect.die(new Error("expected recovery claim"))
        const exhausted = yield* jobs.retry({
          ...authority(recovered),
          runAt,
          failureVersion: 1,
          failure: { message: "last failure" },
        })
        return { retried, early, second, exhausted }
      }),
    )

    expect(result.retried).toMatchObject({
      status: "retry_scheduled",
      runAt: new Date("2026-08-12T10:05:00.000Z"),
    })
    expect(result.early).toBeNull()
    expect(result.second.attempt).toBe(2)
    expect(result.exhausted).toMatchObject({ status: "failed", attempt: 3 })
  })

  test("replays an identical result and rejects a changed result identity or content", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const claim = yield* claimJob("result-replay")
        const completion = {
          ...authority(claim),
          resultId: "result-1",
          resultVersion: 1,
          result: { verdict: "pass", detail: { b: 2, a: 1 } },
        }
        const first = yield* jobs.complete(completion)
        const exact = yield* jobs.complete({
          ...completion,
          result: { detail: { a: 1, b: 2 }, verdict: "pass" },
        })
        const changed = yield* jobs
          .complete({ ...completion, result: { verdict: "fail" } })
          .pipe(Effect.result)
        const changedId = yield* jobs
          .complete({ ...completion, resultId: "result-2" })
          .pipe(Effect.result)
        return { first, exact, changed, changedId }
      }),
    )

    expect([result.first.status, result.exact.status]).toEqual(["completed", "duplicate"])
    expect(result.changed._tag).toBe("Failure")
    expect(result.changedId._tag).toBe("Failure")
  })

  test("rejects an exact result replay without the originally accepted claim authority", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const claim = yield* claimJob("stale-result-replay")
        const completion = {
          ...authority(claim),
          resultId: "stale-result",
          resultVersion: 1,
          result: { ok: true },
        }
        yield* jobs.complete(completion)
        return yield* jobs
          .complete({ ...completion, claimToken: "wrong-token" })
          .pipe(Effect.result)
      }),
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      left: { _tag: "KernelJobStoreLeaseError", jobId: "stale-result-replay" },
    })
  })

  test("rejects reuse of a result identity by another job as a typed conflict", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const first = yield* claimJob("result-owner-a")
        yield* jobs.complete({
          ...authority(first),
          resultId: "shared-identity",
          resultVersion: 1,
          result: { owner: "a" },
        })
        const second = yield* claimJob("result-owner-b")
        return yield* jobs
          .complete({
            ...authority(second),
            resultId: "shared-identity",
            resultVersion: 1,
            result: { owner: "b" },
          })
          .pipe(Effect.result)
      }),
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      left: { _tag: "KernelJobStoreConflictError", record: "result", key: "shared-identity" },
    })
  })

  test("reads durable recoverable jobs and terminal results for status inspection", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("inspect-ready")
        const claim = yield* claimJob("inspect-complete")
        yield* jobs.complete({
          ...authority(claim),
          resultId: "inspect-result",
          resultVersion: 1,
          result: { ok: true },
        })
        return {
          ready: yield* jobs.readJob("inspect-ready"),
          completed: yield* jobs.readJob("inspect-complete"),
          result: yield* jobs.readResult("inspect-complete"),
          recoverable: yield* jobs.readRecoverable(),
        }
      }),
    )

    expect(result.ready).toMatchObject({ jobId: "inspect-ready", state: "ready" })
    expect(result.completed).toMatchObject({ jobId: "inspect-complete", state: "succeeded" })
    expect(result.result).toMatchObject({ resultId: "inspect-result", result: { ok: true } })
    expect(result.recoverable.map(({ jobId }) => jobId)).toEqual(["inspect-ready"])
  })

  test("survives restart with ready, scheduled, active, expired, succeeded, and failed states", async () => {
    const filename = `${process.cwd()}/kernel-job-restart-${crypto.randomUUID()}.sqlite`
    const { removeDatabase } = await import("./job-store-harness")
    try {
      await runKernel(
        filename,
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          for (const id of ["active", "expired", "failed", "scheduled", "succeeded"]) {
            yield* arrangeJob(id)
          }
          const active = yield* jobs.claimNext({ workerId: "old", now, leaseDurationMs: 600_000 })
          const expired = yield* jobs.claimNext({ workerId: "old", now, leaseDurationMs: 1 })
          const failed = yield* jobs.claimNext({ workerId: "old", now, leaseDurationMs: 60_000 })
          const scheduled = yield* jobs.claimNext({ workerId: "old", now, leaseDurationMs: 60_000 })
          const succeeded = yield* jobs.claimNext({ workerId: "old", now, leaseDurationMs: 60_000 })
          if (!active || !expired || !failed || !scheduled || !succeeded) {
            return yield* Effect.die(new Error("expected arranged claims"))
          }
          yield* jobs.fail({ ...authority(failed), failureVersion: 1, failure: { message: "no" } })
          yield* jobs.retry({
            ...authority(scheduled),
            runAt: new Date("2026-08-12T11:00:00.000Z"),
            failureVersion: 1,
            failure: { message: "later" },
          })
          yield* jobs.complete({
            ...authority(succeeded),
            resultId: "restart-result",
            resultVersion: 1,
            result: { ok: true },
          })
          yield* arrangeJob("ready")
        }),
      )

      const claims = await runKernel(
        filename,
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          const first = yield* jobs.claimNext({
            workerId: "new",
            now: new Date("2026-08-12T10:00:00.001Z"),
            leaseDurationMs: 60_000,
          })
          const second = yield* jobs.claimNext({
            workerId: "new",
            now: new Date("2026-08-12T10:00:00.001Z"),
            leaseDurationMs: 60_000,
          })
          const none = yield* jobs.claimNext({
            workerId: "new",
            now: new Date("2026-08-12T10:00:00.001Z"),
            leaseDurationMs: 60_000,
          })
          return { first, second, none }
        }),
      )
      expect([claims.first?.jobId, claims.second?.jobId].sort()).toEqual(["expired", "ready"])
      expect(claims.none).toBeNull()
    } finally {
      await removeDatabase(filename)
    }
  })
})

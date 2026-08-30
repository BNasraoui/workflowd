import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Fiber } from "effect"
import { TestJobCanary, TestJobCanaryLive } from "../../src/kernel/test-job-canary"
import { KernelJobStore } from "../../src/kernel/job-store"
import { runKernelJobIteration } from "../../src/kernel/job-runner"
import { now, runKernel } from "./job-store-harness"

describe("test job canary", () => {
  test("transactionally submits a test job and exactly replays it", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        const first = yield* canary.submit({ jobId: "deployment-42", value: { probe: true } }, now)
        const replay = yield* canary.submit(
          { jobId: "deployment-42", value: { probe: true } },
          new Date(now.getTime() + 60_000),
        )
        return { first, replay, status: yield* canary.status("deployment-42") }
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(result).toEqual({
      first: { jobId: "deployment-42", status: "pending", newlyEnqueued: true },
      replay: { jobId: "deployment-42", status: "pending", newlyEnqueued: false },
      status: { jobId: "deployment-42", status: "pending" },
    })
  })

  test("stable replay preserves the initially persisted job schedule and creation time", async () => {
    const persisted = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        const sql = yield* SqlClient.SqlClient
        yield* canary.submit({ jobId: "deployment-stable-time", value: "same" }, now)
        yield* canary.submit(
          { jobId: "deployment-stable-time", value: "same" },
          new Date(now.getTime() + 60_000),
        )
        return yield* sql<{ readonly run_at: string; readonly created_at: string }>`
          SELECT run_at, created_at FROM kernel_workflow_jobs
        `
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(persisted).toEqual([{ run_at: now.toISOString(), created_at: now.toISOString() }])
  })

  test("rejects a replay whose value changed for the same public job ID", async () => {
    const conflict = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        yield* canary.submit({ jobId: "deployment-43", value: "first" }, now)
        return yield* Effect.result(
          canary.submit({ jobId: "deployment-43", value: "changed" }, now),
        )
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(conflict).toMatchObject({
      _tag: "Failure",
      left: { _tag: "TestJobCanaryConflict", jobId: "deployment-43" },
    })
  })

  test("concurrent identical submissions converge on one durable job", async () => {
    const submissions = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        const input = { jobId: "deployment-concurrent", value: [1, true, null] } as const
        const fibers = yield* Effect.all(
          Array.from({ length: 8 }, () => canary.submit(input, now).pipe(Effect.forkChild)),
        )
        return yield* Effect.forEach(fibers, Fiber.join)
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(submissions.filter((item) => item.newlyEnqueued)).toHaveLength(1)
    expect(submissions.every((item) => item.status === "pending")).toBe(true)
  })

  test("reports lifecycle states and exposes the result only after success", async () => {
    const observed = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        const jobs = yield* KernelJobStore
        yield* canary.submit({ jobId: "deployment-lifecycle", value: { ok: true } }, now)
        const pending = yield* canary.status("deployment-lifecycle")
        const claim = yield* jobs.claimNext({ workerId: "worker-a", now, leaseDurationMs: 60_000 })
        const running = yield* canary.status("deployment-lifecycle")
        if (claim === null) return yield* Effect.die(new Error("expected claim"))
        yield* jobs.retry({
          ...claim,
          expectedLeaseUntil: claim.leaseUntil,
          now,
          runAt: new Date(now.getTime() + 1_000),
          failureVersion: 1,
          failure: { message: "retry" },
        })
        const retrying = yield* canary.status("deployment-lifecycle")
        yield* runKernelJobIteration({
          workerId: "worker-b",
          now: () => new Date(now.getTime() + 1_000),
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return {
          pending,
          running,
          retrying,
          succeeded: yield* canary.status("deployment-lifecycle"),
        }
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(observed).toEqual({
      pending: { jobId: "deployment-lifecycle", status: "pending" },
      running: { jobId: "deployment-lifecycle", status: "running" },
      retrying: { jobId: "deployment-lifecycle", status: "retrying" },
      succeeded: {
        jobId: "deployment-lifecycle",
        status: "succeeded",
        result: { ok: true },
      },
    })
  })

  test("preserves terminal failure labels and rejects unknown IDs", async () => {
    const observed = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        const jobs = yield* KernelJobStore
        yield* canary.submit({ jobId: "deployment-failed", value: false }, now)
        const claim = yield* jobs.claimNext({ workerId: "worker-a", now, leaseDurationMs: 60_000 })
        if (claim === null) return yield* Effect.die(new Error("expected claim"))
        yield* jobs.fail({
          ...claim,
          expectedLeaseUntil: claim.leaseUntil,
          now,
          failureVersion: 1,
          failure: { message: "permanent" },
        })
        return {
          failed: yield* canary.status("deployment-failed"),
          unknown: yield* Effect.result(canary.status("unknown")),
        }
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(observed.failed).toEqual({ jobId: "deployment-failed", status: "failed" })
    expect(observed.unknown).toMatchObject({
      _tag: "Failure",
      left: { _tag: "TestJobCanaryNotFound", jobId: "unknown" },
    })
  })

  test("replays the current succeeded state and result", async () => {
    const replay = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        yield* canary.submit({ jobId: "deployment-replayed-result", value: "complete" }, now)
        yield* runKernelJobIteration({
          workerId: "worker-a",
          now: () => now,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return yield* canary.submit(
          { jobId: "deployment-replayed-result", value: "complete" },
          new Date(now.getTime() + 1_000),
        )
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(replay).toEqual({
      jobId: "deployment-replayed-result",
      status: "succeeded",
      result: "complete",
      newlyEnqueued: false,
    })
  })

  test("fails succeeded status safely when the persisted result is missing or corrupt", async () => {
    const cases = [
      { id: "missing", resultVersion: 1, result: null },
      { id: "wrong-version", resultVersion: 2, result: { kind: "echo", value: "safe" } },
      { id: "malformed", resultVersion: 1, result: { kind: "echo" } },
      { id: "arbitrary", resultVersion: 1, result: { secret: true } },
    ] as const

    for (const item of cases) {
      const outcome = await runKernel(
        ":memory:",
        Effect.gen(function* () {
          const canary = yield* TestJobCanary
          const sql = yield* SqlClient.SqlClient
          yield* canary.submit({ jobId: `corrupt-${item.id}`, value: "safe" }, now)
          yield* runKernelJobIteration({
            workerId: "worker-a",
            now: () => now,
            leaseDurationMs: 60_000,
            retryDelayMs: 1_000,
          })
          if (item.result === null) {
            yield* sql`DELETE FROM kernel_workflow_job_results`
          } else {
            yield* sql`UPDATE kernel_workflow_job_results
              SET result_version = ${item.resultVersion}, result_json = ${JSON.stringify(item.result)}`
          }
          return yield* Effect.result(canary.status(`corrupt-${item.id}`))
        }).pipe(Effect.provide(TestJobCanaryLive)),
      )

      expect(outcome).toMatchObject({
        _tag: "Failure",
        left: { _tag: "KernelJobStoreDataError", record: "result" },
      })
    }
  })

  test("uses human-readable labels for every durable job state", async () => {
    const states = [
      ["ready", "pending"],
      ["leased", "running"],
      ["retry_scheduled", "retrying"],
      ["succeeded", "succeeded"],
      ["failed", "failed"],
      ["operator_required", "operator-required"],
      ["data_error", "data-error"],
    ] as const

    const labels = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const canary = yield* TestJobCanary
        const sql = yield* SqlClient.SqlClient
        return yield* Effect.forEach(states, ([state]) =>
          Effect.gen(function* () {
            const id = `state-${state}`
            yield* canary.submit({ jobId: id, value: null }, now)
            if (state === "succeeded") {
              yield* runKernelJobIteration({
                workerId: "worker",
                now: () => now,
                leaseDurationMs: 1_000,
                retryDelayMs: 1_000,
              })
            } else {
              yield* sql`UPDATE kernel_workflow_jobs SET state = ${state},
                lease_worker_id = CASE WHEN ${state} = 'leased' THEN 'worker' ELSE NULL END,
                claim_token = CASE WHEN ${state} = 'leased' THEN 'claim' ELSE NULL END,
                lease_until = CASE WHEN ${state} = 'leased' THEN ${new Date(now.getTime() + 1_000).toISOString()} ELSE NULL END`
            }
            const label = (yield* canary.status(id)).status
            yield* sql`UPDATE kernel_workflow_jobs SET state = 'failed',
              lease_worker_id = NULL, claim_token = NULL, lease_until = NULL`
            return label
          }),
        )
      }).pipe(Effect.provide(TestJobCanaryLive)),
    )

    expect(Array.from(labels)).toEqual(states.map(([, expected]) => expected))
  })
})

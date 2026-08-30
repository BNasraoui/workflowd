import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import {
  KernelJobStore,
  type JobClaim,
  type KernelJobStoreError,
  type KernelJobStorePort,
} from "../../src/kernel/job-store"
import { arrangeJob, authority, claimJob, expiry, now, runKernel } from "./job-store-harness"

type TransitionCase = {
  readonly name: string
  readonly run: (
    claim: JobClaim,
    input: ReturnType<typeof authority>,
  ) => Effect.Effect<void, KernelJobStoreError, KernelJobStorePort>
}

const transitionCases: ReadonlyArray<TransitionCase> = [
  {
    name: "heartbeat",
    run: (_claim: JobClaim, input: ReturnType<typeof authority>) =>
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* jobs.heartbeat({ ...input, leaseDurationMs: 60_000 })
      }),
  },
  {
    name: "complete",
    run: (claim: JobClaim, input: ReturnType<typeof authority>) =>
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* jobs.complete({
          ...input,
          resultId: `result-${claim.jobId}`,
          resultVersion: 1,
          result: { ok: true },
        })
      }),
  },
  {
    name: "fail",
    run: (_claim: JobClaim, input: ReturnType<typeof authority>) =>
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* jobs.fail({ ...input, failureVersion: 1, failure: { message: "bad" } })
      }),
  },
  {
    name: "retry",
    run: (_claim: JobClaim, input: ReturnType<typeof authority>) =>
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* jobs.retry({
          ...input,
          runAt: new Date("2026-08-12T11:00:00.000Z"),
          failureVersion: 1,
          failure: { message: "later" },
        })
      }),
  },
]

describe("kernel lease authority", () => {
  for (const transition of transitionCases) {
    test(`${transition.name} rejects stale worker, attempt, token, expected expiry, and exact expiry`, async () => {
      const dimensions = [
        (claim: JobClaim) => ({ ...authority(claim), workerId: "other-worker" }),
        (claim: JobClaim) => ({ ...authority(claim), attempt: claim.attempt + 1 }),
        (claim: JobClaim) => ({ ...authority(claim), claimToken: "other-token" }),
        (claim: JobClaim) => ({
          ...authority(claim),
          expectedLeaseUntil: new Date(claim.leaseUntil.getTime() + 1),
        }),
        (claim: JobClaim) => authority(claim, claim.leaseUntil),
      ]
      const tags = []
      for (const [index, mutate] of dimensions.entries()) {
        tags.push(
          await runKernel(
            ":memory:",
            Effect.gen(function* () {
              const claim = yield* claimJob(`${transition.name}-${index}`)
              const result = yield* Effect.result(transition.run(claim, mutate(claim)))
              return result._tag === "Failure" ? result.failure._tag : result._tag
            }),
          ),
        )
      }
      expect(tags).toEqual(Array.from({ length: 5 }, () => "KernelJobStoreLeaseError"))
    })
  }

  test("lease validity uses a strict boundary for claim and all owner transitions", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("matrix")
        const claim = yield* jobs.claimNext({ workerId: "first", now, leaseDurationMs: 60_000 })
        if (claim === null) return yield* Effect.die(new Error("expected claim"))
        const before = new Date(expiry.getTime() - 1)
        const unavailable = yield* jobs.claimNext({
          workerId: "second",
          now: before,
          leaseDurationMs: 1,
        })
        const heartbeat = yield* jobs.heartbeat({
          ...authority(claim, before),
          leaseDurationMs: 2,
        })
        const atOldExpiry = yield* jobs.claimNext({
          workerId: "second",
          now: expiry,
          leaseDurationMs: 60_000,
        })
        const recovered = yield* jobs.claimNext({
          workerId: "second",
          now: heartbeat.leaseUntil,
          leaseDurationMs: 60_000,
        })
        return { claim, unavailable, heartbeat, atOldExpiry, recovered }
      }),
    )

    expect(result.unavailable).toBeNull()
    expect(result.atOldExpiry).toBeNull()
    expect(result.heartbeat.leaseUntil).toEqual(new Date(expiry.getTime() + 1))
    expect(result.recovered).toMatchObject({ jobId: "matrix", workerId: "second", attempt: 2 })
    expect(result.recovered?.claimToken).not.toBe(result.claim.claimToken)
  })

  test("expired recovery issues a fresh token and increments the attempt", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const first = yield* claimJob("recover")
        const recovered = yield* jobs.claimNext({
          workerId: "worker-b",
          now: first.leaseUntil,
          leaseDurationMs: 60_000,
        })
        return { first, recovered }
      }),
    )

    expect(result.recovered).toMatchObject({ attempt: 2, workerId: "worker-b" })
    expect(result.recovered?.claimToken).not.toBe(result.first.claimToken)
  })

  test("an expired final attempt becomes terminal instead of remaining stuck leased", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const input = yield* arrangeJob("final-expiry")
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE kernel_workflow_jobs SET max_attempts = 1 WHERE job_id = ${input.jobId}`
        const claim = yield* jobs.claimNext({ workerId: "lost", now, leaseDurationMs: 1 })
        if (claim === null) return yield* Effect.die(new Error("expected final claim"))
        const replacement = yield* jobs.claimNext({
          workerId: "replacement",
          now: claim.leaseUntil,
          leaseDurationMs: 60_000,
        })
        return { replacement, job: yield* jobs.readJob(input.jobId) }
      }),
    )

    expect(result.replacement).toBeNull()
    expect(result.job).toMatchObject({ state: "failed", attempt: 1 })
  })
})

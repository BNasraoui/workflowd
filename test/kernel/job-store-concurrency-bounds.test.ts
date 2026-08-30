import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { Effect } from "effect"
import {
  KernelJobStore,
  MAX_KERNEL_JOB_IDENTIFIER_BYTES,
  MAX_KERNEL_JOB_PAYLOAD_BYTES,
} from "../../src/kernel/job-store"
import {
  arrangeDelivery,
  arrangeJob,
  authority,
  claimJob,
  now,
  removeDatabase,
  runKernel,
} from "./job-store-harness"

describe("kernel job concurrency", () => {
  test("independent SQLite clients allow exactly one claimant", async () => {
    const filename = `${process.cwd()}/kernel-job-claim-${crypto.randomUUID()}.sqlite`
    try {
      await runKernel(filename, arrangeJob("race"))
      const claim = (workerId: string) =>
        runKernel(
          filename,
          Effect.gen(function* () {
            const jobs = yield* KernelJobStore
            return yield* jobs.claimNext({ workerId, now, leaseDurationMs: 60_000 })
          }),
        )
      const claims = await Promise.all([claim("worker-a"), claim("worker-b")])
      expect(claims.filter((item) => item !== null)).toHaveLength(1)
      expect(claims.filter((item) => item === null)).toHaveLength(1)
      expect(claims.find((item) => item !== null)).toMatchObject({ jobId: "race", attempt: 1 })
    } finally {
      await removeDatabase(filename)
    }
  })

  test("identical concurrent completions commit one result and replay the other", async () => {
    const filename = `${process.cwd()}/kernel-job-result-${crypto.randomUUID()}.sqlite`
    try {
      const claim = await runKernel(filename, claimJob("result-race"))
      const complete = () =>
        runKernel(
          filename,
          Effect.gen(function* () {
            const jobs = yield* KernelJobStore
            return yield* jobs.complete({
              ...authority(claim),
              resultId: "shared-result",
              resultVersion: 1,
              result: { b: 2, a: 1 },
            })
          }),
        )
      const results = await Promise.all([complete(), complete()])
      expect(results.map(({ status }) => status).sort()).toEqual(["completed", "duplicate"])
    } finally {
      await removeDatabase(filename)
    }
  })

  test("conflicting concurrent completions commit one result and reject the other", async () => {
    const filename = `${process.cwd()}/kernel-job-result-conflict-${crypto.randomUUID()}.sqlite`
    try {
      const claim = await runKernel(filename, claimJob("result-conflict"))
      const complete = (result: string | { readonly value: string }) =>
        runKernel(
          filename,
          Effect.gen(function* () {
            const jobs = yield* KernelJobStore
            return yield* jobs
              .complete({
                ...authority(claim),
                resultId: "shared-result",
                resultVersion: 1,
                result,
              })
              .pipe(Effect.result)
          }),
        )
      const results = await Promise.all([complete({ value: "a" }), complete({ value: "b" })])
      expect(results.filter(({ _tag }) => _tag === "Success")).toHaveLength(1)
      expect(results.filter(({ _tag }) => _tag === "Failure")).toHaveLength(1)
    } finally {
      await removeDatabase(filename)
    }
  })
})

describe("kernel job storage envelopes", () => {
  test("bounds identifiers by exact UTF-8 bytes", async () => {
    const exactId = "é".repeat(MAX_KERNEL_JOB_IDENTIFIER_BYTES / 2)
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const exact = yield* arrangeDelivery(exactId)
        const accepted = yield* jobs.enqueueFromDelivery(exact).pipe(Effect.result)
        const oversized = yield* jobs
          .enqueueFromDelivery({ ...exact, jobId: `${exactId}a` })
          .pipe(Effect.result)
        return { accepted, oversized }
      }),
    )
    expect(result.accepted._tag).toBe("Success")
    expect(result.oversized).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "KernelJobStoreInputError" },
    })
  })

  test("accepts exact JSON byte maxima and rejects max plus one for input, failure, and result", async () => {
    const exactAscii = "a".repeat(MAX_KERNEL_JOB_PAYLOAD_BYTES - 2)
    const exactUnicode = "é".repeat((MAX_KERNEL_JOB_PAYLOAD_BYTES - 2) / 2)
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const exactInput = yield* arrangeDelivery("input-exact", exactUnicode)
        const inputAccepted = yield* jobs.enqueueFromDelivery(exactInput).pipe(Effect.result)
        const inputOversized = yield* arrangeDelivery("input-large", `${exactUnicode}a`)
        const inputRejected = yield* jobs.enqueueFromDelivery(inputOversized).pipe(Effect.result)

        const resultClaim = yield* claimJob("result-size")
        const resultAccepted = yield* jobs
          .complete({
            ...authority(resultClaim),
            resultId: "result-size-id",
            resultVersion: 1,
            result: exactAscii,
          })
          .pipe(Effect.result)
        const oversizedResultClaim = yield* claimJob("result-large")
        const resultRejected = yield* jobs
          .complete({
            ...authority(oversizedResultClaim),
            resultId: "result-large-id",
            resultVersion: 1,
            result: `${exactAscii}a`,
          })
          .pipe(Effect.result)

        const failureClaim = yield* claimJob("failure-size")
        const failureAccepted = yield* jobs
          .fail({ ...authority(failureClaim), failureVersion: 1, failure: exactUnicode })
          .pipe(Effect.result)
        const oversizedFailureClaim = yield* claimJob("failure-large")
        const failureRejected = yield* jobs
          .fail({
            ...authority(oversizedFailureClaim),
            failureVersion: 1,
            failure: `${exactUnicode}a`,
          })
          .pipe(Effect.result)
        return {
          inputAccepted,
          inputRejected,
          resultAccepted,
          resultRejected,
          failureAccepted,
          failureRejected,
        }
      }),
    )

    expect(
      [result.inputAccepted, result.resultAccepted, result.failureAccepted].map(({ _tag }) => _tag),
    ).toEqual(["Success", "Success", "Success"])
    expect(
      [result.inputRejected, result.resultRejected, result.failureRejected].map(({ _tag }) => _tag),
    ).toEqual(["Failure", "Failure", "Failure"])
  })

  test("isolates a poison row and still claims the next valid job", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const sql = yield* SqlClient.SqlClient
        yield* arrangeJob("a-poison")
        yield* arrangeJob("b-valid")
        yield* sql`PRAGMA ignore_check_constraints = ON`
        yield* sql`UPDATE kernel_workflow_jobs SET input_json = '{bad'
          WHERE job_id = 'a-poison'`
        const claimed = yield* jobs.claimNext({ workerId: "worker", now, leaseDurationMs: 60_000 })
        const poison = yield* sql`SELECT state, failure_category FROM kernel_workflow_jobs
          WHERE job_id = 'a-poison'`
        return { claimed, poison }
      }),
    )

    expect(result.claimed).toMatchObject({ jobId: "b-valid", attempt: 1 })
    expect(result.poison).toEqual([{ state: "data_error", failure_category: "data_error" }])
  })
})

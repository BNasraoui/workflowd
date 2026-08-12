import { expect, test } from "bun:test"
import { Effect } from "effect"
import { KernelJobStore } from "../../src/kernel/job-store"
import { runKernelJobIteration } from "../../src/kernel/job-runner"
import { arrangeJob, now, removeDatabase, runKernel } from "./job-store-harness"

test("runKernelJobIteration recovers an expired lease after a file-backed layer restart", async () => {
  const filename = `${process.cwd()}/kernel-job-restart-${crypto.randomUUID()}.sqlite`
  try {
    await runKernel(
      filename,
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("restart-expired-lease", { kind: "echo", value: "leased" })
        yield* jobs.claimNext({ workerId: "stopped-worker", now, leaseDurationMs: 1_000 })
      }),
    )

    const recovered = await runKernel(
      filename,
      runKernelJobIteration({
        workerId: "restarted-worker",
        now: () => new Date(now.getTime() + 1_000),
        leaseDurationMs: 60_000,
        retryDelayMs: 1_000,
      }),
    )

    expect(recovered).toEqual({ status: "completed", jobId: "restart-expired-lease" })
  } finally {
    await removeDatabase(filename)
  }
})

test("runKernelJobIteration recovers a due scheduled retry after a file-backed layer restart", async () => {
  const filename = `${process.cwd()}/kernel-job-retry-restart-${crypto.randomUUID()}.sqlite`
  const due = new Date(now.getTime() + 1_000)
  try {
    await runKernel(
      filename,
      Effect.gen(function* () {
        yield* arrangeJob("restart-due-retry", { kind: "echo", value: "retry" })
        yield* runKernelJobIteration({
          workerId: "stopped-worker",
          now: () => now,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
          execute: () => Effect.fail(new Error("transient")),
        })
      }),
    )

    const recovered = await runKernel(
      filename,
      runKernelJobIteration({
        workerId: "restarted-worker",
        now: () => due,
        leaseDurationMs: 60_000,
        retryDelayMs: 1_000,
      }),
    )

    expect(recovered).toEqual({ status: "completed", jobId: "restart-due-retry" })
  } finally {
    await removeDatabase(filename)
  }
})

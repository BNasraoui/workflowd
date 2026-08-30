import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { KernelJobStore } from "../../src/kernel/job-store"
import { MAX_KERNEL_JOB_RETRY_DELAY_MS, runKernelJobIteration } from "../../src/kernel/job-runner"
import { arrangeDelivery, arrangeJob, now, runKernel } from "./job-store-harness"

describe("kernel job runner", () => {
  test("claims one ready version-1 echo job and completes its deterministic result", async () => {
    const value = { nested: [null, true, 3, "echo"] }
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("echo-ready", { kind: "echo", value })
        const iteration = yield* runKernelJobIteration({
          workerId: "runner-a",
          now: () => now,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return {
          iteration,
          job: yield* jobs.readJob("echo-ready"),
          result: yield* jobs.readResult("echo-ready"),
        }
      }),
    )

    expect(result.iteration).toEqual({ status: "completed", jobId: "echo-ready" })
    expect(result.job?.state).toBe("succeeded")
    expect(result.result).toMatchObject({
      resultId: "echo-ready",
      resultVersion: 1,
      result: { kind: "echo", value },
    })
  })

  test("marks an unknown input version operator-required", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        const delivery = yield* arrangeDelivery("unknown-version", {
          kind: "echo",
          value: "ignored",
        })
        yield* jobs.enqueueFromDelivery({ ...delivery, inputVersion: 2 })
        const iteration = yield* runKernelJobIteration({
          workerId: "runner-a",
          now: () => now,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return {
          iteration,
          job: yield* jobs.readJob("unknown-version"),
          result: yield* jobs.readResult("unknown-version"),
        }
      }),
    )

    expect(result.iteration).toEqual({ status: "operator_required", jobId: "unknown-version" })
    expect(result.job?.state).toBe("operator_required")
    expect(result.result).toBeNull()
  })

  test("marks unknown, malformed, and excess-field version-1 inputs operator-required", async () => {
    const cases = [
      { id: "unknown-kind", input: { kind: "other", value: null } },
      { id: "missing-value", input: { kind: "echo" } },
      { id: "extra-field", input: { kind: "echo", value: null, extra: true } },
    ] as const

    for (const item of cases) {
      const result = await runKernel(
        ":memory:",
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          yield* arrangeJob(item.id, item.input)
          const iteration = yield* runKernelJobIteration({
            workerId: "runner-a",
            now: () => now,
            leaseDurationMs: 60_000,
            retryDelayMs: 1_000,
          })
          return { iteration, job: yield* jobs.readJob(item.id) }
        }),
      )

      expect(result.iteration).toEqual({ status: "operator_required", jobId: item.id })
      expect(result.job?.state).toBe("operator_required")
    }
  })

  test("fails a parent-resume action closed when custody services are unavailable", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("resume-without-custody", {
          kind: "resume_parent_agent",
          parentSessionId: "parent-stable",
          resumePrompt: { task: "Continue." },
          resumePromptText: '{"task":"Continue."}',
          outputContract: "test.parent-result",
          outputContractVersion: 1,
          registeredAt: now.toISOString(),
        })
        const iteration = yield* runKernelJobIteration({
          workerId: "runner-a",
          now: () => now,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return { iteration, job: yield* jobs.readJob("resume-without-custody") }
      }),
    )

    expect(result.iteration).toEqual({
      status: "operator_required",
      jobId: "resume-without-custody",
    })
    expect(result.job?.state).toBe("operator_required")
  })

  test("schedules an injected transient execution failure before a fresh claim succeeds", async () => {
    const failedAt = new Date(now.getTime() + 500)
    const runAt = new Date(failedAt.getTime() + 1_000)
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("echo-retry", { kind: "echo", value: "eventual" })
        const times = [now, failedAt]
        const failed = yield* runKernelJobIteration({
          workerId: "runner-a",
          now: () => times.shift()!,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
          execute: () => Effect.fail(new Error("injected transient failure")),
        })
        const scheduled = yield* jobs.readJob("echo-retry")
        const early = yield* runKernelJobIteration({
          workerId: "runner-b",
          now: () => new Date(runAt.getTime() - 1),
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        const succeeded = yield* runKernelJobIteration({
          workerId: "runner-b",
          now: () => runAt,
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
        })
        return {
          failed,
          scheduled,
          early,
          succeeded,
          job: yield* jobs.readJob("echo-retry"),
          stored: yield* jobs.readResult("echo-retry"),
        }
      }),
    )

    expect(result.failed).toEqual({
      status: "retry_scheduled",
      jobId: "echo-retry",
      runAt,
    })
    expect(result.scheduled).toMatchObject({ state: "retry_scheduled", attempt: 1, runAt })
    expect(result.early).toEqual({ status: "idle" })
    expect(result.succeeded).toEqual({ status: "completed", jobId: "echo-retry" })
    expect(result.job).toMatchObject({ state: "succeeded", attempt: 2 })
    expect(result.stored?.result).toEqual({ kind: "echo", value: "eventual" })
  })

  test("rejects a late first completion after a fresh claim has completed", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("echo-authority", { kind: "echo", value: "first" })
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const first = yield* runKernelJobIteration({
          workerId: "runner-a",
          now: () => now,
          leaseDurationMs: 1,
          retryDelayMs: 1_000,
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            ),
        }).pipe(Effect.result, Effect.forkChild)
        yield* Deferred.await(started)
        const second = yield* runKernelJobIteration({
          workerId: "runner-b",
          now: () => new Date(now.getTime() + 1),
          leaseDurationMs: 60_000,
          retryDelayMs: 1_000,
          execute: () => Effect.void,
        })
        yield* Deferred.succeed(release, undefined)
        const late = yield* Fiber.join(first)
        return {
          second,
          late,
          job: yield* jobs.readJob("echo-authority"),
          stored: yield* jobs.readResult("echo-authority"),
        }
      }),
    )

    expect(result.second).toEqual({ status: "completed", jobId: "echo-authority" })
    expect(result.late).toMatchObject({
      _tag: "Failure",
      left: { _tag: "KernelJobStoreLeaseError", jobId: "echo-authority" },
    })
    expect(result.job).toMatchObject({ state: "succeeded", attempt: 2 })
    expect(result.stored?.result).toEqual({ kind: "echo", value: "first" })
  })

  test("rejects completion and retry when execution advances beyond lease expiry", async () => {
    for (const outcome of ["complete", "retry"] as const) {
      const afterExpiry = new Date(now.getTime() + 2)
      const times = [now, afterExpiry]
      const clock = () => times.shift()!
      const result = await runKernel(
        ":memory:",
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          yield* arrangeJob(`echo-expired-${outcome}`, { kind: "echo", value: outcome })
          const late = yield* runKernelJobIteration({
            workerId: "runner-a",
            now: clock,
            leaseDurationMs: 1,
            retryDelayMs: 1_000,
            execute: () =>
              outcome === "complete"
                ? Effect.void
                : Effect.fail(new Error("injected transient failure")),
          }).pipe(Effect.result)
          return { late, job: yield* jobs.readJob(`echo-expired-${outcome}`) }
        }),
      )

      expect(result.late).toMatchObject({
        _tag: "Failure",
        left: { _tag: "KernelJobStoreLeaseError", jobId: `echo-expired-${outcome}` },
      })
      expect(result.job).toMatchObject({ state: "leased", attempt: 1 })
    }
  })

  test("bounds an injected transient retry delay", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        const jobs = yield* KernelJobStore
        yield* arrangeJob("echo-bounded-retry", { kind: "echo", value: null })
        const iteration = yield* runKernelJobIteration({
          workerId: "runner-a",
          now: () => now,
          leaseDurationMs: 60_000,
          retryDelayMs: Number.MAX_SAFE_INTEGER,
          execute: () => Effect.fail(new Error("injected transient failure")),
        })
        return { iteration, job: yield* jobs.readJob("echo-bounded-retry") }
      }),
    )
    const boundedRunAt = new Date(now.getTime() + MAX_KERNEL_JOB_RETRY_DELAY_MS)

    expect(result.iteration).toEqual({
      status: "retry_scheduled",
      jobId: "echo-bounded-retry",
      runAt: boundedRunAt,
    })
    expect(result.job?.runAt).toEqual(boundedRunAt)
  })

  test("normalizes a non-finite transient retry delay to zero", async () => {
    const result = await runKernel(
      ":memory:",
      Effect.gen(function* () {
        yield* arrangeJob("echo-finite-retry", { kind: "echo", value: null })
        return yield* runKernelJobIteration({
          workerId: "runner-a",
          now: () => now,
          leaseDurationMs: 60_000,
          retryDelayMs: Number.NaN,
          execute: () => Effect.fail(new Error("injected transient failure")),
        })
      }),
    )

    expect(result).toEqual({ status: "retry_scheduled", jobId: "echo-finite-retry", runAt: now })
  })
})

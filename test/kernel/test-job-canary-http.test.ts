import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope } from "effect"
import { routeRequest } from "../../src/http"
import { runKernelJobIteration } from "../../src/kernel/job-runner"
import { TestJobCanary, TestJobCanaryLive } from "../../src/kernel/test-job-canary"
import { superviseWorker } from "../../src/runtime"
import { WorkSignal, WorkSignalLive } from "../../src/work-signal"
import { kernelLayer, now } from "./job-store-harness"

const token = "test-job-secret"
const authorization = { authorization: `Bearer ${token}` }

const liveLayer = Layer.merge(
  TestJobCanaryLive.pipe(Layer.provideMerge(kernelLayer(":memory:"))),
  WorkSignalLive,
)

const within = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds = 500) =>
  Effect.race(
    effect.pipe(Effect.map((value) => ({ _tag: "Completed" as const, value }))),
    Effect.sleep(milliseconds).pipe(Effect.as({ _tag: "TimedOut" as const })),
  )

describe("test-job canary HTTP integration", () => {
  test("a committed POST promptly wakes an idle kernel supervisor and GET returns the exact echo", async () => {
    let executions = 0
    const value = { nested: [null, true, 3, "echo"] }
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const canary = yield* TestJobCanary
          const signals = yield* WorkSignal
          const idle = yield* Deferred.make<void>()
          const executed = yield* Deferred.make<void>()
          const submit = canary.submit
          const request = (input: Request) =>
            routeRequest(input, {
              webhookSecret: "unused",
              now,
              testJobs: {
                token,
                submit: (submission, submittedAt) =>
                  submit(submission, submittedAt).pipe(
                    Effect.tap((result) =>
                      result.newlyEnqueued ? signals.wake("kernel-job") : Effect.void,
                    ),
                  ),
                status: canary.status,
              },
            })

          yield* superviseWorker(
            "Kernel canary test worker",
            60_000,
            "kernel-job",
            Effect.suspend(() =>
              runKernelJobIteration({
                workerId: "canary-worker",
                now: () => now,
                leaseDurationMs: 60_000,
                retryDelayMs: 1_000,
                execute: () =>
                  Effect.sync(() => {
                    executions += 1
                  }).pipe(Effect.andThen(Deferred.succeed(executed, undefined)), Effect.asVoid),
              }),
            ).pipe(
              Effect.tap((result) =>
                result.status === "idle" ? Deferred.succeed(idle, undefined) : Effect.void,
              ),
              Effect.map((result) => result.status),
            ),
          )
          yield* Deferred.await(idle)
          const executionsWhileIdle = executions

          const post = yield* request(
            new Request("http://localhost/workflows/test-jobs", {
              method: "POST",
              headers: authorization,
              body: JSON.stringify({ jobId: "wake-and-echo", value }),
            }),
          )
          const wake = yield* within(Deferred.await(executed))
          const get = yield* request(
            new Request("http://localhost/workflows/test-jobs/wake-and-echo", {
              headers: authorization,
            }),
          )

          return {
            executionsWhileIdle,
            executions,
            postStatus: post.status,
            wake,
            getStatus: get.status,
            body: yield* Effect.promise(() => get.json()),
          }
        }),
      ).pipe(Effect.provide(liveLayer)),
    )

    expect(observed).toEqual({
      executionsWhileIdle: 0,
      executions: 1,
      postStatus: 202,
      wake: { _tag: "Completed", value: undefined },
      getStatus: 200,
      body: { jobId: "wake-and-echo", status: "succeeded", result: value },
    })
  })

  test("an exact duplicate POST is harmless and creates neither another wake nor execution", async () => {
    let executions = 0
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const canary = yield* TestJobCanary
          const signals = yield* WorkSignal
          const initiallyIdle = yield* Deferred.make<void>()
          const settledIdle = yield* Deferred.make<void>()
          const submit = canary.submit
          const request = (input: Request) =>
            routeRequest(input, {
              webhookSecret: "unused",
              now,
              testJobs: {
                token,
                submit: (submission, submittedAt) =>
                  submit(submission, submittedAt).pipe(
                    Effect.tap((result) =>
                      result.newlyEnqueued ? signals.wake("kernel-job") : Effect.void,
                    ),
                  ),
                status: canary.status,
              },
            })

          yield* superviseWorker(
            "Kernel duplicate test worker",
            60_000,
            "kernel-job",
            Effect.suspend(() =>
              runKernelJobIteration({
                workerId: "duplicate-worker",
                now: () => now,
                leaseDurationMs: 60_000,
                retryDelayMs: 1_000,
                execute: () =>
                  Effect.sync(() => {
                    executions += 1
                  }),
              }),
            ).pipe(
              Effect.tap((result) =>
                result.status !== "idle"
                  ? Effect.void
                  : executions === 0
                    ? Deferred.succeed(initiallyIdle, undefined)
                    : Deferred.succeed(settledIdle, undefined),
              ),
              Effect.map((result) => result.status),
            ),
          )
          yield* Deferred.await(initiallyIdle)
          const body = JSON.stringify({ jobId: "exact-duplicate", value: { same: true } })
          const first = yield* request(
            new Request("http://localhost/workflows/test-jobs", {
              method: "POST",
              headers: authorization,
              body,
            }),
          )
          yield* Deferred.await(settledIdle)
          const duplicateWake = yield* signals.subscribe("kernel-job")
          const duplicate = yield* request(
            new Request("http://localhost/workflows/test-jobs", {
              method: "POST",
              headers: authorization,
              body,
            }),
          )
          const wake = yield* within(Queue.take(duplicateWake), 100)

          return {
            statuses: [first.status, duplicate.status],
            duplicateBody: yield* Effect.promise(() => duplicate.json()),
            wake,
            executions,
          }
        }),
      ).pipe(Effect.provide(liveLayer)),
    )

    expect(observed).toEqual({
      statuses: [202, 202],
      duplicateBody: { jobId: "exact-duplicate", status: "succeeded", result: { same: true } },
      wake: { _tag: "TimedOut" },
      executions: 1,
    })
  })

  test("concurrent identical POSTs converge on one durable execution and changed JSON conflicts", async () => {
    let executions = 0
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const canary = yield* TestJobCanary
          const signals = yield* WorkSignal
          const sql = yield* SqlClient.SqlClient
          const idle = yield* Deferred.make<void>()
          const executionStarted = yield* Deferred.make<void>()
          const releaseExecution = yield* Deferred.make<void>()
          const completed = yield* Deferred.make<void>()
          const submit = canary.submit
          const request = (value: unknown) =>
            routeRequest(
              new Request("http://localhost/workflows/test-jobs", {
                method: "POST",
                headers: authorization,
                body: JSON.stringify({ jobId: "concurrent-http", value }),
              }),
              {
                webhookSecret: "unused",
                now,
                testJobs: {
                  token,
                  submit: (submission, submittedAt) =>
                    submit(submission, submittedAt).pipe(
                      Effect.tap((result) =>
                        result.newlyEnqueued ? signals.wake("kernel-job") : Effect.void,
                      ),
                    ),
                  status: canary.status,
                },
              },
            )

          yield* superviseWorker(
            "Kernel concurrent test worker",
            60_000,
            "kernel-job",
            Effect.suspend(() =>
              runKernelJobIteration({
                workerId: "concurrent-worker",
                now: () => now,
                leaseDurationMs: 60_000,
                retryDelayMs: 1_000,
                execute: () =>
                  Effect.sync(() => {
                    executions += 1
                  }).pipe(
                    Effect.andThen(Deferred.succeed(executionStarted, undefined)),
                    Effect.andThen(Deferred.await(releaseExecution)),
                  ),
              }),
            ).pipe(
              Effect.tap((result) =>
                result.status === "idle"
                  ? Deferred.succeed(idle, undefined)
                  : result.status === "completed"
                    ? Deferred.succeed(completed, undefined)
                    : Effect.void,
              ),
              Effect.map((result) => result.status),
            ),
          )
          yield* Deferred.await(idle)
          const responses = yield* Effect.all(
            Array.from({ length: 8 }, () => request({ stable: [1, true, null] })),
            { concurrency: "unbounded" },
          )
          const started = yield* within(Deferred.await(executionStarted))
          yield* Deferred.succeed(releaseExecution, undefined)
          yield* Deferred.await(completed)
          const counts = yield* sql<{
            readonly events: number
            readonly deliveries: number
            readonly jobs: number
          }>`SELECT
            (SELECT COUNT(*) FROM kernel_events) AS events,
            (SELECT COUNT(*) FROM kernel_wait_event_deliveries) AS deliveries,
            (SELECT COUNT(*) FROM kernel_workflow_jobs) AS jobs`
          const conflict = yield* request({ stable: [1, true, "changed"] })

          return {
            statuses: responses.map((response) => response.status),
            started,
            counts: counts[0],
            executions,
            conflictStatus: conflict.status,
            conflictBody: yield* Effect.promise(() => conflict.json()),
          }
        }),
      ).pipe(Effect.provide(liveLayer)),
    )

    expect(observed).toEqual({
      statuses: Array.from({ length: 8 }, () => 202),
      started: { _tag: "Completed", value: undefined },
      counts: { events: 2, deliveries: 1, jobs: 1 },
      executions: 1,
      conflictStatus: 409,
      conflictBody: { error: "conflict" },
    })
  })

  test("closing its scope interrupts an idle kernel supervisor lane", async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const idle = yield* Deferred.make<void>()
          const workerScope = yield* Scope.make()
          const worker = yield* Scope.extend(
            superviseWorker(
              "Idle kernel shutdown test worker",
              60_000,
              "kernel-job",
              Deferred.succeed(idle, undefined).pipe(Effect.as("idle" as const)),
            ),
            workerScope,
          )
          yield* Deferred.await(idle)
          yield* Scope.close(workerScope, Exit.void)
          const stopped = yield* within(Fiber.await(worker))
          return {
            stopped,
            interrupted:
              stopped._tag === "Completed" && Exit.isFailure(stopped.value)
                ? Cause.isInterruptedOnly(stopped.value.cause)
                : false,
          }
        }).pipe(Effect.provide(WorkSignalLive)),
      ),
    )

    expect(observed.interrupted).toBe(true)
    expect(observed.stopped._tag).toBe("Completed")
  })
})

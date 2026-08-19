import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, Scope } from "effect"
import { GitHub } from "../src/github"
import {
  HookHttpServerStartError,
  serveHookHttp,
  superviseWorker,
  workDownstreamLanes,
} from "../src/runtime"
import { WorkflowStore } from "../src/store/contracts"
import { WorkerHealthLive } from "../src/worker-health"
import { WorkSignal, WorkSignalLive } from "../src/work-signal"
import { runPublicationIteration } from "../src/worker"
import { changesRequestedReview, makeStoreLayer, samplePullRequestEvent } from "./store/harness"

describe("serveHookHttp", () => {
  test("stops the listener and joins interrupted in-flight request effects", async () => {
    const lifecycle = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        const server = yield* Scope.extend(
          serveHookHttp(
            {
              host: "127.0.0.1",
              port: 0,
              maxWebhookBytes: 1_024,
              webhookSecret: "secret",
            },
            () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              ),
          ),
          scope,
        )
        const request = yield* Effect.fork(
          Effect.tryPromise(() => fetch(`http://${server.hostname}:${server.port}/blocked`)).pipe(
            Effect.exit,
          ),
        )
        yield* Deferred.await(started)
        yield* Scope.close(scope, Exit.void)
        yield* Deferred.await(interrupted)
        const requestExit = yield* Fiber.join(request)
        return { interrupted: true, requestExit }
      }),
    )

    expect(lifecycle.interrupted).toBe(true)
    expect(lifecycle.requestExit._tag).toBe("Failure")
  })

  test("fails shutdown after draining requests when stopping the listener rejects", async () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      logs.push({ level: logLevel.label, message })
    })
    const CapturingLogger = Logger.replace(Logger.defaultLogger, logger)
    const started = await Effect.runPromise(Deferred.make<void>())
    const interrupted = await Effect.runPromise(Deferred.make<void>())
    const scope = await Effect.runPromise(Scope.make())
    const server = await Effect.runPromise(
      Scope.extend(
        serveHookHttp(
          {
            host: "127.0.0.1",
            port: 0,
            maxWebhookBytes: 1_024,
            webhookSecret: "secret",
          },
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            ),
        ),
        scope,
      ).pipe(Effect.provide(CapturingLogger)),
    )
    const stop = server.stop.bind(server)
    server.stop = () => Promise.reject(new Error("stop failed before listener stopped"))

    try {
      const lifecycle = await Effect.runPromise(
        Effect.gen(function* () {
          const request = yield* Effect.fork(
            Effect.tryPromise(() => fetch(`http://${server.hostname}:${server.port}/blocked`)).pipe(
              Effect.exit,
            ),
          )
          yield* Deferred.await(started)
          const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit)
          const interruption = yield* Deferred.poll(interrupted)
          const requestExit = yield* Fiber.join(request)
          return { closeExit, interruption, requestExit }
        }).pipe(Effect.provide(CapturingLogger)),
      )

      expect(lifecycle.closeExit._tag).toBe("Failure")
      if (Exit.isFailure(lifecycle.closeExit)) {
        expect(Array.from(Cause.defects(lifecycle.closeExit.cause))).toEqual([
          expect.objectContaining({ _tag: "UnknownException" }),
        ])
      }
      expect(lifecycle.interruption._tag).toBe("Some")
      expect(lifecycle.requestExit._tag).toBe("Success")
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        level: "ERROR",
        message: ["Failed to stop webhook listener", { _tag: "UnknownException" }],
      })
    } finally {
      await stop(true)
    }
  })

  test("fails with a tagged error when the listener cannot be acquired", async () => {
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    })
    if (occupied.port === undefined) throw new Error("occupied listener has no port")
    const occupiedPort = occupied.port

    try {
      const failure = await Effect.runPromise(
        Effect.scoped(
          serveHookHttp(
            {
              host: "127.0.0.1",
              port: occupiedPort,
              maxWebhookBytes: 1_024,
              webhookSecret: "secret",
            },
            () => Effect.succeed(new Response("ok")),
          ).pipe(Effect.flip),
        ),
      )

      expect(failure).toBeInstanceOf(HookHttpServerStartError)
      expect(failure._tag).toBe("HookHttpServerStartError")
      expect(failure.cause).toBeInstanceOf(Error)
    } finally {
      await occupied.stop(true)
    }
  })
})

test("superviseWorker resumes the same worker after an iteration failure", async () => {
  let attempts = 0
  const recovered = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const resumed = yield* Deferred.make<void>()
        yield* superviseWorker(
          "Test worker",
          0,
          "job",
          Effect.suspend(() => {
            attempts += 1
            return attempts === 1
              ? Effect.fail("transient")
              : Deferred.succeed(resumed, undefined).pipe(Effect.andThen(Effect.never))
          }),
        )
        yield* Deferred.await(resumed)
        return attempts
      }),
    ).pipe(Effect.provide(Layer.merge(WorkSignalLive, WorkerHealthLive))),
  )

  expect(recovered).toBe(2)
})

test("superviseWorker subscribes before its first claim and consumes a wake after idle", async () => {
  let attempts = 0
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const signals = yield* WorkSignal
        const claimedAgain = yield* Deferred.make<void>()
        yield* superviseWorker(
          "Test worker",
          60_000,
          "job",
          Effect.suspend(() => {
            attempts += 1
            return attempts === 1
              ? signals.wake("job").pipe(Effect.as("idle" as const))
              : Deferred.succeed(claimedAgain, undefined).pipe(Effect.as("idle" as const))
          }),
        )
        yield* Deferred.await(claimedAgain)
        return attempts
      }).pipe(Effect.provide(Layer.merge(WorkSignalLive, WorkerHealthLive))),
    ),
  )

  expect(observed).toBe(2)
})

test("superviseWorker retains fallback polling after an idle iteration", async () => {
  let attempts = 0
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const claimedAgain = yield* Deferred.make<void>()
        yield* superviseWorker(
          "Test worker",
          5,
          "job",
          Effect.sync(() => {
            attempts += 1
            if (attempts === 2) Effect.runSync(Deferred.succeed(claimedAgain, undefined))
            return "idle" as const
          }),
        )
        yield* Deferred.await(claimedAgain)
        return attempts
      }).pipe(Effect.provide(Layer.merge(WorkSignalLive, WorkerHealthLive))),
    ),
  )

  expect(observed).toBe(2)
})

test("superviseWorker preserves error backoff and scoped shutdown", async () => {
  let attempts = 0
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const signals = yield* WorkSignal
        const failed = yield* Deferred.make<void>()
        const resumed = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const workerScope = yield* Scope.make()
        yield* Scope.extend(
          superviseWorker(
            "Test worker",
            40,
            "job",
            Effect.suspend(() => {
              attempts += 1
              if (attempts === 1) {
                return Deferred.succeed(failed, undefined).pipe(
                  Effect.andThen(Effect.fail("transient")),
                )
              }
              return Deferred.succeed(resumed, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              )
            }),
          ),
          workerScope,
        )
        yield* Deferred.await(failed)
        yield* signals.wake("job")
        yield* Effect.sleep(10)
        const attemptsDuringBackoff = attempts
        yield* Deferred.await(resumed)
        yield* Scope.close(workerScope, Exit.void)
        yield* Deferred.await(interrupted)
        return { attemptsDuringBackoff, attempts }
      }).pipe(Effect.provide(Layer.merge(WorkSignalLive, WorkerHealthLive))),
    ),
  )

  expect(result).toEqual({ attemptsDuringBackoff: 1, attempts: 2 })
})

test("publication completion wakes the job lane that now exposes queued Fix Work", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const signals = yield* WorkSignal
        yield* store.ingestPullRequest(
          {
            deliveryId: "publication-unlocks-fix",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-20T12:00:00.000Z"),
          },
          samplePullRequestEvent,
        )
        const review = yield* store.claimNextJob({
          workerId: "review-worker",
          now: new Date("2026-07-20T12:01:00.000Z"),
          leaseDurationMs: 60_000,
        })
        if (review === null) return yield* Effect.dieMessage("expected review")
        yield* store.completeReviewJob({
          jobId: review.id,
          workerId: "review-worker",
          completedAt: new Date("2026-07-20T12:01:01.000Z"),
          review: changesRequestedReview,
          autoFix: true,
        })
        const blockedFix = yield* store.claimNextJob({
          workerId: "early-fix-worker",
          now: new Date("2026-07-20T12:01:02.000Z"),
          leaseDurationMs: 60_000,
        })
        const jobWake = yield* signals.subscribe("job")
        yield* superviseWorker(
          "Publisher",
          60_000,
          "publication",
          runPublicationIteration({
            workerId: "publication-worker",
            leaseDurationMs: 60_000,
            maxAttempts: 3,
            timeoutMs: 10_000,
            now: () => new Date("2026-07-20T12:02:00.000Z"),
          }),
        )
        yield* Queue.take(jobWake)
        const fix = yield* store.claimNextJob({
          workerId: "fix-worker",
          now: new Date("2026-07-20T12:02:01.000Z"),
          leaseDurationMs: 60_000,
        })
        return { blockedFix, fix }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeStoreLayer(),
            WorkSignalLive,
            WorkerHealthLive,
            Layer.succeed(GitHub, {
              fetchPullRequestSnapshot: () => Effect.die("unused"),
              collectHeadEvidence: () => Effect.die("unused"),
              publishReview: () => Effect.succeed("published"),
            }),
          ),
        ),
      ),
    ),
  )

  expect(result.blockedFix).toBeNull()
  expect(result.fix?._tag).toBe("FixWork")
})

test("job, command, and reconciliation workers declare conservative downstream wakes", () => {
  expect(workDownstreamLanes("job")).toEqual(["publication"])
  expect(workDownstreamLanes("publication")).toEqual(["job"])
  expect(workDownstreamLanes("command")).toEqual(["job"])
  expect(workDownstreamLanes("reconciliation")).toEqual(["job"])
})

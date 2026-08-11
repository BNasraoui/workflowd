import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, Scope } from "effect"
import { AgentHarness } from "../src/agent-harness"
import { loadConfig } from "../src/config"
import { GitHub } from "../src/github"
import { Automation, OpenCodeAutomationError } from "../src/opencode"
import {
  HookHttpServerStartError,
  runHookService,
  serveHookHttp,
  startHookService,
  superviseWorker,
  workDownstreamLanes,
} from "../src/runtime"
import { WorkflowStoreLive } from "../src/store"
import { WorkflowStore } from "../src/store/contracts"
import { Workspace } from "../src/workspace"
import { WorkSignal, WorkSignalLive } from "../src/work-signal"
import { runPublicationIteration } from "../src/worker"
import {
  WorkflowStart,
  WorkflowStartValidationError,
  closedWorkflowStart,
} from "../src/qrspi/workflow-start"
import { changesRequestedReview, makeStoreLayer, samplePullRequestEvent } from "./store/harness"

const qrspiDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [
    {
      key: "questions",
      kind: "document",
      contract: { name: "qrspi.questions", contractVersion: 1 },
      activation: { mode: "enabled" },
      definitionVersion: 1,
      maxEncodedInputBytes: 16_384,
      producer: {
        harness: { name: "opencode", version: 1 },
        agent: "qrspi-questions",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 60_000,
        retry: { maxAttempts: 3, backoffMs: 1_000 },
      },
      outputPolicy: {
        _tag: "Artifact",
        pathTemplate: "docs/qrspi/{ticketId}/01-questions.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" },
      humanGatePolicy: { mode: "none" },
    },
  ],
}

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
    ).pipe(Effect.provide(WorkSignalLive)),
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
      }).pipe(Effect.provide(WorkSignalLive)),
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
      }).pipe(Effect.provide(WorkSignalLive)),
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
      }).pipe(Effect.provide(WorkSignalLive)),
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

describe("runHookService startup", () => {
  test("validates OpenCode exactly once before listener or workers activate", async () => {
    let validations = 0
    let githubCalls = 0
    const loaded = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
    }
    const StoreLive = WorkflowStoreLive.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )
    const TestAdapters = Layer.mergeAll(
      WorkSignalLive,
      Layer.succeed(GitHub, {
        fetchPullRequestSnapshot: () => {
          githubCalls += 1
          return Effect.die("must not fetch")
        },
        publishReview: () => {
          githubCalls += 1
          return Effect.die("must not publish")
        },
        collectHeadEvidence: () => Effect.die("must not collect evidence"),
      }),
      Layer.succeed(Automation, {
        validateAvailability: () =>
          Effect.sync(() => {
            validations += 1
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new OpenCodeAutomationError({
                  operation: "validate OpenCode availability",
                  cause: new Error("missing fixer agent"),
                  retryable: false,
                }),
              ),
            ),
          ),
        prepareReview: () => Effect.die("must not review"),
        prepareFix: () => Effect.die("must not fix"),
      }),
      Layer.succeed(AgentHarness, {
        describe: () => Effect.die("must not describe harness"),
        validateAvailability: () => Effect.die("must not validate harness"),
        prepare: () => Effect.die("must not prepare harness"),
        createSession: () => Effect.die("must not create session"),
        resumeSession: () => Effect.die("must not resume session"),
        abortSession: () => Effect.void,
      }),
      Layer.succeed(Workspace, {
        prepareReview: () => Effect.die("must not prepare review"),
        prepareFix: () => Effect.die("must not prepare fix"),
        publishFix: () => Effect.die("must not publish fix"),
      }),
    )

    const exit = await Effect.runPromise(
      Effect.exit(
        runHookService(config).pipe(Effect.provide(Layer.merge(StoreLive, TestAdapters))),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(validations).toBe(1)
    expect(githubCalls).toBe(0)
  })

  test("composes workers and starts a healthy listener after validation", async () => {
    let validations = 0
    const observedWorkers = new Set<string>()
    const loaded = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: "/tmp",
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, pollIntervalMs: 60_000 },
    }
    const StoreLive = WorkflowStoreLive.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )
    const TestAdapters = Layer.mergeAll(
      WorkSignalLive,
      Layer.succeed(GitHub, {
        fetchPullRequestSnapshot: () => Effect.die("unexpected fetch"),
        publishReview: () => Effect.die("unexpected publish"),
        collectHeadEvidence: () => Effect.die("unexpected evidence collection"),
      }),
      Layer.succeed(Automation, {
        validateAvailability: () =>
          Effect.sync(() => {
            validations += 1
          }),
        prepareReview: () => Effect.die("unexpected review"),
        prepareFix: () => Effect.die("unexpected fix"),
      }),
      Layer.succeed(AgentHarness, {
        describe: () => Effect.die("unexpected harness description"),
        validateAvailability: () => Effect.die("unexpected harness validation"),
        prepare: () => Effect.die("unexpected harness preparation"),
        createSession: () => Effect.die("unexpected session creation"),
        resumeSession: () => Effect.die("unexpected session resume"),
        abortSession: () => Effect.die("unexpected session abort"),
      }),
      Layer.succeed(Workspace, {
        prepareReview: () => Effect.die("unexpected review workspace"),
        prepareFix: () => Effect.die("unexpected fix workspace"),
        publishFix: () => Effect.die("unexpected fix publication"),
      }),
      Layer.succeed(
        WorkflowStart,
        closedWorkflowStart(
          new WorkflowStartValidationError({
            phase: "availability",
            reason: "unavailable_agent_model",
          }),
        ),
      ),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const allWorkersObserved = yield* Deferred.make<void>()
          const server = yield* startHookService(config, (worker) =>
            Effect.gen(function* () {
              observedWorkers.add(worker)
              if (observedWorkers.size === 4) {
                yield* Deferred.succeed(allWorkersObserved, undefined)
              }
            }),
          )
          yield* Deferred.await(allWorkersObserved)
          const response = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/health`),
          )
          const qrspiResponse = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/workflows/qrspi`, {
              method: "POST",
              body: "{}",
              headers: { authorization: "Bearer kickoff-secret" },
            }),
          )
          return {
            health: {
              status: response.status,
              body: yield* Effect.promise(() => response.json()),
            },
            qrspi: {
              status: qrspiResponse.status,
              body: yield* Effect.promise(() => qrspiResponse.json()),
            },
          }
        }),
      ).pipe(Effect.provide(Layer.merge(StoreLive, TestAdapters))),
    )

    expect(validations).toBe(1)
    expect(observedWorkers).toEqual(new Set(["job", "publication", "reconciliation", "command"]))
    expect(result).toEqual({
      health: { status: 200, body: { status: "ok" } },
      qrspi: { status: 503, body: { error: "WorkflowStartValidationError" } },
    })
  })
})

import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Scope, PubSub } from "effect"
import { AgentHarness } from "../src/agent-harness"
import { loadConfig } from "../src/config"
import {
  DOGFOOD_ENRICHMENT_CONTRACT,
  DogfoodStore,
  type DogfoodEnrichmentDocument,
} from "../src/kernel/dogfood-store"
import { GitHub } from "../src/github"
import { KernelJobStore } from "../src/kernel/job-store"
import { runKernelJobIteration } from "../src/kernel/job-runner"
import { OpenCodeResumeWorker } from "../src/kernel/opencode-resume-worker"
import { TestJobCanary } from "../src/kernel/test-job-canary"
import { RemoteCoordinator } from "../src/remote/coordinator"
import { Automation, OpenCodeAutomationError } from "../src/opencode"
import {
  HookHttpServerStartError,
  runHookService,
  serveHookHttp,
  startHookService,
  superviseOpenCodeResumeWorker,
  superviseWorker,
  workDownstreamLanes,
} from "../src/runtime"
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
import { arrangeDelivery, kernelLayer } from "./kernel/job-store-harness"

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

/**
 * Every runtime adapter stubbed to die on use. Wiring tests merge extra
 * layers (logger, coordinator, stores) on top; pass an Automation stub to
 * observe availability validation instead of ignoring it.
 */
const automationStub = (validateAvailability: () => Effect.Effect<void> = () => Effect.void) => ({
  validateAvailability,
  prepareReview: () => Effect.die("unexpected review"),
  prepareFix: () => Effect.die("unexpected fix"),
})

const stubAdapters = (automation = automationStub()) =>
  Layer.mergeAll(
    WorkSignalLive,
    Layer.succeed(GitHub, {
      fetchPullRequestSnapshot: () => Effect.die("unexpected fetch"),
      publishReview: () => Effect.die("unexpected publish"),
      collectHeadEvidence: () => Effect.die("unexpected evidence collection"),
    }),
    Layer.succeed(Automation, automation),
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
  )

describe("serveHookHttp", () => {
  test("stops the listener and joins interrupted in-flight request effects", async () => {
    const lifecycle = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        const server = yield* Scope.provide(
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
        const request = yield* Effect.forkChild(
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
      logs.push({ level: logLevel, message })
    })
    const CapturingLogger = Logger.layer([logger])
    const started = await Effect.runPromise(Deferred.make<void>())
    const interrupted = await Effect.runPromise(Deferred.make<void>())
    const scope = await Effect.runPromise(Scope.make())
    const server = await Effect.runPromise(
      Scope.provide(
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
          const request = yield* Effect.forkChild(
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
        expect(
          lifecycle.closeExit.cause.reasons
            .filter(Cause.isDieReason)
            .map((reason) => reason.defect),
        ).toEqual([expect.objectContaining({ _tag: "UnknownError" })])
      }
      expect(lifecycle.interruption._tag).toBe("Some")
      expect(lifecycle.requestExit._tag).toBe("Success")
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        level: "Error",
        message: ["Failed to stop webhook listener", { _tag: "UnknownError" }],
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

test("local resume supervision performs a startup scan and uses its signal lane", async () => {
  let attempts = 0
  const scanned = await Effect.runPromise(Deferred.make<void>())
  const woke = await Effect.runPromise(Deferred.make<void>())
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const signals = yield* WorkSignal
        yield* superviseOpenCodeResumeWorker(60_000)
        yield* Deferred.await(scanned)
        yield* signals.wake("session-resume")
        yield* Deferred.await(woke)
        return attempts
      }).pipe(
        Effect.provide(
          Layer.merge(
            WorkSignalLive,
            Layer.succeed(OpenCodeResumeWorker, {
              iteration: Effect.sync(() => {
                attempts += 1
                if (attempts === 1) Effect.runSync(Deferred.succeed(scanned, undefined))
                if (attempts === 2) Effect.runSync(Deferred.succeed(woke, undefined))
                return "idle" as const
              }),
            }),
          ),
        ),
      ),
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
        yield* Scope.provide(
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
        if (review === null) return yield* Effect.die(new Error("expected review"))
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
        yield* PubSub.take(jobWake)
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
  expect(workDownstreamLanes("session-resume")).toEqual([])
})

describe("runHookService startup", () => {
  test("starts local HTTP while remote coordination is unavailable and recovers later", async () => {
    const loaded = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_REMOTE_COORDINATOR_ENABLED: "true",
        WORKFLOWD_NATS_SERVERS: "nats://127.0.0.1:1",
        WORKFLOWD_NATS_TOKEN: "test-token",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, concurrency: 0, pollIntervalMs: 60_000 },
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const brokerAvailable = yield* Deferred.make<void>()
          const recovered = yield* Deferred.make<void>()
          const coordinator = {
            ensure: Deferred.await(brokerAvailable),
            dispatchIteration: Deferred.succeed(recovered, undefined).pipe(
              Effect.as("idle" as const),
            ),
            resultIteration: Effect.succeed("idle" as const),
          }
          const adapters = Layer.mergeAll(
            Logger.layer([Logger.make(() => undefined)]),
            stubAdapters(),
            Layer.succeed(RemoteCoordinator, coordinator),
          )
          const started = yield* Effect.race(
            startHookService(config).pipe(
              Effect.map((server) => server as Bun.Server<undefined> | null),
            ),
            Effect.sleep(250).pipe(Effect.as(null)),
          ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), adapters)))
          if (started === null) return { started: false, health: 0, recovered: false }
          const health = yield* Effect.tryPromise(() =>
            fetch(`http://${started.hostname}:${started.port}/health`),
          )
          yield* Deferred.succeed(brokerAvailable, undefined)
          const didRecover = yield* Effect.race(
            Deferred.await(recovered).pipe(Effect.as(true)),
            Effect.sleep(250).pipe(Effect.as(false)),
          )
          return { started: true, health: health.status, recovered: didRecover }
        }),
      ),
    )

    expect(result).toEqual({ started: true, health: 200, recovered: true })
  })

  test("starts one kernel job supervisor and immediately processes ready work", async () => {
    let kernelIterations = 0
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
      worker: { ...loaded.worker, concurrency: 3, pollIntervalMs: 60_000 },
    }
    const TestAdapters = stubAdapters()

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          const delivery = yield* arrangeDelivery("startup-kernel-job", {
            kind: "echo",
            value: "ready",
          })
          yield* jobs.enqueueFromDelivery({ ...delivery, runAt: new Date(0) })
          const waiting = yield* Deferred.make<void>()
          yield* startHookService(config, (worker) => {
            if (worker !== "kernel-job") return Effect.void
            kernelIterations += 1
            return kernelIterations === 2 ? Deferred.succeed(waiting, undefined) : Effect.void
          })
          yield* Deferred.await(waiting)
          yield* Effect.sleep(10)
          return yield* jobs.readJob("startup-kernel-job")
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), TestAdapters))),
    )

    expect(result?.state).toBe("succeeded")
    expect(kernelIterations).toBe(2)
  })

  test("kernel supervisor polls a scheduled transient retry on the worker interval", async () => {
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
      worker: { ...loaded.worker, concurrency: 1, pollIntervalMs: 10 },
    }
    const TestAdapters = stubAdapters()

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          const delivery = yield* arrangeDelivery("supervised-kernel-retry", {
            kind: "echo",
            value: "eventual",
          })
          yield* jobs.enqueueFromDelivery({ ...delivery, runAt: new Date(0) })
          const failedAt = new Date()
          yield* runKernelJobIteration({
            workerId: "failing-worker",
            now: () => failedAt,
            leaseDurationMs: 60_000,
            retryDelayMs: 50,
            execute: () => Effect.fail(new Error("injected transient failure")),
          })
          const succeeded = yield* Deferred.make<void>()
          yield* startHookService(config)
          const waiter = yield* jobs.readJob("supervised-kernel-retry").pipe(
            Effect.flatMap((job) =>
              job?.state === "succeeded" ? Deferred.succeed(succeeded, undefined) : Effect.void,
            ),
            Effect.andThen(Effect.sleep(1)),
            Effect.forever,
            Effect.forkScoped,
          )
          yield* Effect.race(
            Deferred.await(succeeded),
            Effect.sleep(500).pipe(Effect.as("timeout")),
          )
          yield* Fiber.interrupt(waiter)
          return yield* jobs.readJob("supervised-kernel-retry")
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), TestAdapters))),
    )

    expect(outcome?.state).toBe("succeeded")
  })

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
        runHookService(config).pipe(
          Effect.provide(Layer.merge(kernelLayer(":memory:"), TestAdapters)),
        ),
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
        WORKFLOWD_TEST_JOB_TOKEN: "test-job-secret",
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
    const TestAdapters = Layer.mergeAll(
      stubAdapters(
        automationStub(() =>
          Effect.sync(() => {
            validations += 1
          }),
        ),
      ),
      Layer.succeed(
        WorkflowStart,
        closedWorkflowStart(
          new WorkflowStartValidationError({
            phase: "availability",
            reason: "unavailable_agent_model",
          }),
        ),
      ),
      Layer.succeed(TestJobCanary, {
        submit: (input) =>
          Effect.succeed({ jobId: input.jobId, status: "pending", newlyEnqueued: true }),
        status: (jobId) => Effect.succeed({ jobId, status: "pending" }),
      }),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const allWorkersObserved = yield* Deferred.make<void>()
          const server = yield* startHookService(config, (worker) =>
            Effect.gen(function* () {
              observedWorkers.add(worker)
              if (observedWorkers.size === 5) {
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
          const testJobResponse = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/workflows/test-jobs`, {
              method: "POST",
              body: '{"jobId":"runtime-canary","value":true}',
              headers: { authorization: "Bearer test-job-secret" },
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
            testJob: {
              status: testJobResponse.status,
              body: yield* Effect.promise(() => testJobResponse.json()),
            },
          }
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), TestAdapters))),
    )

    expect(validations).toBe(1)
    expect(observedWorkers).toEqual(
      new Set(["job", "kernel-job", "publication", "reconciliation", "command"]),
    )
    expect(result).toEqual({
      health: { status: 200, body: { status: "ok" } },
      qrspi: { status: 503, body: { error: "WorkflowStartValidationError" } },
      testJob: { status: 202, body: { jobId: "runtime-canary", status: "pending" } },
    })
  })
})

describe("dogfood enrichment wiring", () => {
  const dogfoodDocument: DogfoodEnrichmentDocument = {
    contract: DOGFOOD_ENRICHMENT_CONTRACT,
    sessions: {
      ses_idle: { harness: "opencode", harness_version: 1, machine: "mint" },
    },
  }

  /** Shared across both wiring tests so the stub block exists exactly once. */
  const loadDogfoodConfig = () =>
    loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_DOGFOOD_TOKEN: "dogfood-secret",
      },
      { home: "/tmp" },
    )

  test("serves the configured route from the wired dogfood store", async () => {
    const loaded = await loadDogfoodConfig()
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, concurrency: 0, pollIntervalMs: 60_000 },
    }
    const adapters = Layer.merge(
      stubAdapters(),
      Layer.succeed(DogfoodStore, { sessions: () => Effect.succeed(dogfoodDocument) }),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startHookService(config)
          const base = `http://${server.hostname}:${server.port}/workflows/dogfood/sessions`
          const authorized = yield* Effect.tryPromise(() =>
            fetch(base, { headers: { authorization: "Bearer dogfood-secret" } }),
          )
          const unauthorized = yield* Effect.tryPromise(() => fetch(base))
          return {
            authorized: {
              status: authorized.status,
              body: yield* Effect.promise(() => authorized.json()),
            },
            unauthorized: unauthorized.status,
          }
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), adapters))),
    )

    expect(result.authorized).toEqual({ status: 200, body: dogfoodDocument })
    expect(result.unauthorized).toBe(401)
  })

  test("refuses to start when dogfood is configured without its store", async () => {
    const loaded = await loadDogfoodConfig()
    const config = { ...loaded, worker: { ...loaded.worker, concurrency: 0 } }

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(startHookService(config)).pipe(
          Effect.provide(Layer.merge(kernelLayer(":memory:"), stubAdapters())),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(Cause.pretty(exit._tag === "Failure" ? exit.cause : Cause.empty)).toContain(
      "Dogfood enrichment is configured without its store",
    )
  })
})

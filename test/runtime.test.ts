import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Scope } from "effect"
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
} from "../src/runtime"
import { Scheduler, SchedulerLive } from "../src/scheduler"
import { WorkflowStoreLive } from "../src/store"
import { Workspace } from "../src/workspace"
import {
  WorkflowStart,
  WorkflowStartValidationError,
  closedWorkflowStart,
} from "../src/qrspi/workflow-start"

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

describe("superviseWorker", () => {
  test("wakes an idle worker promptly before a long fallback interval", async () => {
    const claims = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const firstClaim = yield* Deferred.make<void>()
          const secondClaim = yield* Deferred.make<void>()
          let count = 0
          yield* superviseWorker(
            "test worker",
            "job",
            60_000,
            Effect.suspend(() => {
              count += 1
              const claimed =
                count === 1
                  ? Deferred.succeed(firstClaim, undefined)
                  : count === 2
                    ? Deferred.succeed(secondClaim, undefined)
                    : Effect.void
              return claimed.pipe(Effect.as("idle" as const))
            }),
          )

          yield* Deferred.await(firstClaim)
          yield* scheduler.signal("job")
          yield* Deferred.await(secondClaim).pipe(Effect.timeout("100 millis"))
          return count
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(claims).toBe(2)
  })

  test("does not lose a wake emitted as an idle result is returned", async () => {
    const claims = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const secondClaim = yield* Deferred.make<void>()
          let count = 0
          yield* superviseWorker(
            "test worker",
            "job",
            60_000,
            Effect.suspend(() => {
              count += 1
              if (count === 1) return scheduler.signal("job").pipe(Effect.as("idle" as const))
              return Deferred.succeed(secondClaim, undefined).pipe(Effect.as("idle" as const))
            }),
          )

          yield* Deferred.await(secondClaim).pipe(Effect.timeout("100 millis"))
          return count
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(claims).toBe(2)
  })

  test("keeps a wake emitted during an active iteration pending", async () => {
    const claims = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const active = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const secondClaim = yield* Deferred.make<void>()
          let count = 0
          yield* superviseWorker(
            "test worker",
            "job",
            60_000,
            Effect.suspend(() => {
              count += 1
              if (count === 1) {
                return Deferred.succeed(active, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as("idle" as const),
                )
              }
              return Deferred.succeed(secondClaim, undefined).pipe(Effect.as("idle" as const))
            }),
          )

          yield* Deferred.await(active)
          yield* scheduler.signal("job")
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(secondClaim).pipe(Effect.timeout("100 millis"))
          return count
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(claims).toBe(2)
  })

  test("coalesces active-iteration bursts without spinning", async () => {
    const claims = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const active = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let count = 0
          yield* superviseWorker(
            "test worker",
            "job",
            60_000,
            Effect.suspend(() => {
              count += 1
              if (count === 1) {
                return Deferred.succeed(active, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as("idle" as const),
                )
              }
              return Effect.succeed("idle" as const)
            }),
          )

          yield* Deferred.await(active)
          yield* Effect.all([
            scheduler.signal("job"),
            scheduler.signal("job"),
            scheduler.signal("job"),
          ])
          yield* Deferred.succeed(release, undefined)
          yield* Effect.sleep(30)
          return count
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(claims).toBe(2)
  })

  test("claims again on the fallback interval without a signal", async () => {
    const claims = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const secondClaim = yield* Deferred.make<void>()
          let count = 0
          yield* superviseWorker(
            "test worker",
            "reconciliation",
            10,
            Effect.suspend(() => {
              count += 1
              return (count === 2 ? Deferred.succeed(secondClaim, undefined) : Effect.void).pipe(
                Effect.as("idle" as const),
              )
            }),
          )

          yield* Deferred.await(secondClaim).pipe(Effect.timeout("100 millis"))
          return count
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(claims).toBe(2)
  })

  test("falls back to polling and recovers after an iteration failure", async () => {
    const logs: Array<unknown> = []
    const logger = Logger.make<unknown, void>(({ message }) => logs.push(message))
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const recovered = yield* Deferred.make<void>()
          let count = 0
          yield* superviseWorker(
            "test worker",
            "command",
            20,
            Effect.suspend(() => {
              count += 1
              return count === 1
                ? Effect.fail("claim failed")
                : Deferred.succeed(recovered, undefined).pipe(Effect.as("idle" as const))
            }),
          )

          yield* Effect.sleep(5)
          const beforeFallback = count
          yield* Deferred.await(recovered).pipe(Effect.timeout("100 millis"))
          return { beforeFallback, count }
        }),
      ).pipe(
        Effect.provide(SchedulerLive),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    )

    expect(result).toEqual({ beforeFallback: 1, count: 2 })
    expect(logs).toEqual([["test worker iteration failed"]])
  })

  test.each([
    ["job", "publication"],
    ["command", "job"],
    ["reconciliation", "job"],
  ] as const)("wakes downstream from a successful %s iteration", async (source, downstream) => {
    const woke = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* Scheduler
          const subscription = yield* scheduler.subscribe(downstream)
          let count = 0
          yield* superviseWorker(
            "test worker",
            source,
            60_000,
            Effect.suspend(() => {
              count += 1
              return count === 1 ? Effect.succeed("completed" as const) : Effect.never
            }),
          )

          return yield* subscription.wait.pipe(Effect.as(true), Effect.timeout("100 millis"))
        }),
      ).pipe(Effect.provide(SchedulerLive)),
    )

    expect(woke).toBe(true)
  })
})

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
          "job",
          0,
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
    ).pipe(Effect.provide(SchedulerLive)),
  )

  expect(recovered).toBe(2)
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
          Effect.provide(Layer.mergeAll(StoreLive, TestAdapters, SchedulerLive)),
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
      ).pipe(Effect.provide(Layer.mergeAll(StoreLive, TestAdapters, SchedulerLive))),
    )

    expect(validations).toBe(1)
    expect(observedWorkers).toEqual(new Set(["job", "publication", "reconciliation", "command"]))
    expect(result).toEqual({
      health: { status: 200, body: { status: "ok" } },
      qrspi: { status: 503, body: { error: "WorkflowStartValidationError" } },
    })
  })
})

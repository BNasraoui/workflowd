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
import { WorkflowStoreLive } from "../src/store"
import { Workspace } from "../src/workspace"

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
    ),
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
          return { status: response.status, body: yield* Effect.promise(() => response.json()) }
        }),
      ).pipe(Effect.provide(Layer.merge(StoreLive, TestAdapters))),
    )

    expect(validations).toBe(1)
    expect(observedWorkers).toEqual(new Set(["job", "publication", "reconciliation", "command"]))
    expect(result).toEqual({ status: 200, body: { status: "ok" } })
  })
})

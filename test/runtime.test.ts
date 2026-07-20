import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { loadConfig } from "../src/config"
import { GitHub } from "../src/github"
import { Automation, OpenCodeAutomationError } from "../src/opencode"
import { runHookService, serveHookHttp } from "../src/runtime"
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
                }),
              ),
            ),
          ),
        runReview: () => Effect.die("must not review"),
        runFix: () => Effect.die("must not fix"),
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
})

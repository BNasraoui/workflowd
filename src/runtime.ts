import { Effect, FiberSet } from "effect"
import type { AppConfig } from "./config"
import { routeRequest, type WebhookHandlerOptions } from "./http"
import { Automation } from "./opencode"
import type { WorkflowStorePort } from "./store/contracts"
import {
  runCommandIteration,
  runJobIteration,
  runPublicationIteration,
  runReconciliationIteration,
} from "./worker"

export type HookHttpConfig = {
  readonly host: string
  readonly port: number
  readonly maxWebhookBytes: number
  readonly webhookSecret: string
}

type ScopedHookRouteHandler<R> = (
  request: Request,
  options: WebhookHandlerOptions,
) => Effect.Effect<Response, never, R>

function superviseWorker<A extends string, E, R>(
  name: string,
  pollIntervalMs: number,
  iteration: Effect.Effect<A, E, R>,
) {
  return Effect.forever(
    iteration.pipe(
      Effect.tap((result) => (result === "idle" ? Effect.sleep(pollIntervalMs) : Effect.void)),
      Effect.catchAllCause((cause) =>
        Effect.logError(`${name} iteration failed`, cause).pipe(
          Effect.andThen(Effect.sleep(pollIntervalMs)),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped)
}

export function serveHookHttp(
  config: HookHttpConfig,
): Effect.Effect<Bun.Server<undefined>, never, WorkflowStorePort | import("effect").Scope.Scope>
export function serveHookHttp<R>(
  config: HookHttpConfig,
  handler: ScopedHookRouteHandler<R>,
): Effect.Effect<Bun.Server<undefined>, never, R | import("effect").Scope.Scope>
export function serveHookHttp<R = WorkflowStorePort>(
  config: HookHttpConfig,
  handler: ScopedHookRouteHandler<R> = routeRequest as ScopedHookRouteHandler<R>,
) {
  return Effect.gen(function* () {
    const requests = yield* FiberSet.make<Response, never>()
    const runRequest = yield* FiberSet.runtimePromise(requests)<R>()
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: config.host,
          port: config.port,
          maxRequestBodySize: config.maxWebhookBytes,
          fetch: (request) =>
            runRequest(
              handler(request, {
                webhookSecret: config.webhookSecret,
                maxBodyBytes: config.maxWebhookBytes,
                now: new Date(),
              }).pipe(
                Effect.catchAllCause(() =>
                  Effect.succeed(
                    Response.json({ error: "service shutting down" }, { status: 503 }),
                  ),
                ),
              ),
            ).catch(() => Response.json({ error: "service shutting down" }, { status: 503 })),
        }),
      ),
      (server) =>
        Effect.promise(() => server.stop(true)).pipe(
          Effect.andThen(FiberSet.clear(requests)),
          Effect.andThen(FiberSet.awaitEmpty(requests)),
        ),
    )
  })
}

export function runHookService(config: AppConfig) {
  return Effect.scoped(
    Effect.gen(function* () {
      const automation = yield* Automation

      yield* automation
        .validateAvailability({
          fixWorkEnabled: config.fixWork.enabled,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `OpenCode startup validation failed (${error.operation}): ${String(error.cause)}`,
                { cause: error },
              ),
          ),
        )

      for (let index = 0; index < config.worker.concurrency; index += 1) {
        const workerId = `${process.pid}:worker:${index}`
        yield* superviseWorker(
          "Job worker",
          config.worker.pollIntervalMs,
          runJobIteration({
            workerId,
            leaseDurationMs: config.worker.jobLeaseDurationMs,
            maxAttempts: 3,
            timeoutMs: config.worker.jobTimeoutMs,
            cancellationPollIntervalMs: config.worker.pollIntervalMs,
            agentBranchPrefixes: config.worker.agentBranchPrefixes,
            fixWorkEnabled: config.fixWork.enabled,
            now: () => new Date(),
          }),
        )
      }

      yield* superviseWorker(
        "Publisher",
        config.worker.pollIntervalMs,
        runPublicationIteration({
          workerId: `${process.pid}:publisher`,
          leaseDurationMs: config.worker.publicationLeaseDurationMs,
          timeoutMs: config.worker.publicationTimeoutMs,
          maxAttempts: 5,
          now: () => new Date(),
        }),
      )

      yield* superviseWorker(
        "Reconciliation",
        config.worker.pollIntervalMs,
        runReconciliationIteration({
          workerId: `${process.pid}:reconciler`,
          leaseDurationMs: 2 * 60_000,
          maxAttempts: 5,
          now: () => new Date(),
        }),
      )

      yield* superviseWorker(
        "Command worker",
        config.worker.pollIntervalMs,
        runCommandIteration({
          workerId: `${process.pid}:commands`,
          leaseDurationMs: 60_000,
          maxAttempts: 3,
          commandUsers: config.worker.commandUsers,
          fixWorkEnabled: config.fixWork.enabled,
          now: () => new Date(),
        }),
      )

      // Acquire the listener last so its finalizer stops acceptance and drains
      // request fibers before worker and store scopes are released.
      const server = yield* serveHookHttp({
        ...config.http,
        webhookSecret: config.github.webhookSecret,
      })
      yield* Effect.logInfo(`workflowd listening on http://${server.hostname}:${server.port}`)

      return yield* Effect.never
    }),
  )
}

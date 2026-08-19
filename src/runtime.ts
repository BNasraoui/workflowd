import { Data, Effect, FiberSet, Option, Queue } from "effect"
import type { AppConfig } from "./config"
import { normalizeError } from "./errors"
import { routeRequest, type WebhookHandlerOptions } from "./http"
import { Automation } from "./opencode"
import {
  runCommandIteration,
  runJobIteration,
  runPublicationIteration,
  runReconciliationIteration,
} from "./worker"
import { WorkflowStart } from "./qrspi/workflow-start"
import { WorkerHealth } from "./worker-health"
import { WorkSignal, type WorkLane } from "./work-signal"

export type HookHttpConfig = {
  readonly host: string
  readonly port: number
  readonly maxWebhookBytes: number
  readonly webhookSecret: string
}

export class HookHttpServerStartError extends Data.TaggedError("HookHttpServerStartError")<{
  readonly cause: Error
}> {}

type ScopedHookRouteHandler<R> = (
  request: Request,
  options: WebhookHandlerOptions,
) => Effect.Effect<Response, never, R>

export function superviseWorker<A extends string, E, R>(
  name: string,
  pollIntervalMs: number,
  lane: WorkLane,
  iteration: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const signals = yield* WorkSignal
    const health = yield* WorkerHealth
    const subscription = yield* signals.subscribe(lane)
    const downstream = workDownstreamLanes(lane)
    // Supervision is the only place that sees whether a lane is working, so it
    // is the only place that records it. The loop never exits, which is why a
    // lane failing every iteration has to be reported rather than inferred from
    // the process still running.
    return yield* Effect.forever(
      iteration.pipe(
        Effect.tap(() => health.recordIteration(lane)),
        Effect.flatMap((result) =>
          result === "idle"
            ? Effect.race(Queue.take(subscription), Effect.sleep(pollIntervalMs))
            : Effect.forEach(downstream, signals.wake, { discard: true }),
        ),
        Effect.catchAllCause((cause) =>
          health
            .recordFailure(lane)
            .pipe(
              Effect.andThen(Effect.logError(`${name} iteration failed`, cause)),
              Effect.andThen(Effect.sleep(pollIntervalMs)),
            ),
        ),
      ),
    ).pipe(Effect.forkScoped)
  })
}

function serveHookHttpWithHandler<R>(config: HookHttpConfig, handler: ScopedHookRouteHandler<R>) {
  return Effect.gen(function* () {
    const requests = yield* FiberSet.make<Response, never>()
    const runRequest = yield* FiberSet.runtimePromise(requests)<R>()
    return yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
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
        catch: (cause) => new HookHttpServerStartError({ cause: normalizeError(cause) }),
      }),
      (server) =>
        Effect.tryPromise(() => server.stop(true)).pipe(
          Effect.tapError((error) => Effect.logError("Failed to stop webhook listener", error)),
          Effect.ensuring(
            FiberSet.clear(requests).pipe(Effect.andThen(FiberSet.awaitEmpty(requests))),
          ),
          Effect.orDie,
        ),
    )
  })
}

export function serveHookHttp<R>(
  config: HookHttpConfig,
  handler: ScopedHookRouteHandler<R>,
): Effect.Effect<
  Bun.Server<undefined>,
  HookHttpServerStartError,
  R | import("effect").Scope.Scope
> {
  return serveHookHttpWithHandler(config, handler)
}

export function workDownstreamLanes(lane: WorkLane): ReadonlyArray<WorkLane> {
  switch (lane) {
    case "job":
      return ["publication"]
    case "publication":
    case "command":
    case "reconciliation":
      return ["job"]
  }
}

export function startHookService(config: AppConfig) {
  return Effect.gen(function* () {
    const automation = yield* Automation
    const workflowStart = yield* Effect.serviceOption(WorkflowStart)
    if (config.qrspi !== undefined && Option.isNone(workflowStart)) {
      return yield* Effect.die(new Error("QRSPI is configured without a WorkflowStart service"))
    }

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
        "job",
        runJobIteration({
          workerId,
          leaseDurationMs: config.worker.jobLeaseDurationMs,
          maxAttempts: 3,
          timeoutMs: config.worker.jobTimeoutMs,
          cancellationPollIntervalMs: config.worker.pollIntervalMs,
          agentBranchPrefixes: config.worker.agentBranchPrefixes,
          trustedAgentUsers: config.worker.trustedAgentUsers,
          fixWorkEnabled: config.fixWork.enabled,
          now: () => new Date(),
        }),
      )
    }

    yield* superviseWorker(
      "Publisher",
      config.worker.pollIntervalMs,
      "publication",
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
      "reconciliation",
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
      "command",
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
    const server = yield* serveHookHttpWithHandler(
      {
        ...config.http,
        webhookSecret: config.github.webhookSecret,
      },
      (request, options) =>
        routeRequest(request, {
          ...options,
          ...(config.qrspi === undefined
            ? {}
            : {
                qrspi: {
                  token: config.qrspi.token,
                  start: Option.getOrThrow(workflowStart).start,
                },
              }),
        }),
    )
    yield* Effect.logInfo(`workflowd listening on http://${server.hostname}:${server.port}`)

    return server
  })
}

export function runHookService(config: AppConfig) {
  return Effect.scoped(startHookService(config).pipe(Effect.andThen(Effect.never)))
}

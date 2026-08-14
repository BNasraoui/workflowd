import { Data, Effect, FiberSet, Option, Queue } from "effect"
import type { AppConfig } from "./config"
import { normalizeError } from "./errors"
import { routeRequest, type WebhookHandlerOptions } from "./http"
import { runKernelJobIteration } from "./kernel/job-runner"
import { OpenCodeResumeWorker } from "./kernel/opencode-resume-worker"
import { TestJobCanary, type TestJobSubmission } from "./kernel/test-job-canary"
import { Automation } from "./opencode"
import {
  runCommandIteration,
  runJobIteration,
  runPublicationIteration,
  runReconciliationIteration,
} from "./worker"
import { WorkflowStart } from "./qrspi/workflow-start"
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
    const subscription = yield* signals.subscribe(lane)
    const downstream = workDownstreamLanes(lane)
    return yield* Effect.forever(
      iteration.pipe(
        Effect.flatMap((result) =>
          result === "idle"
            ? Effect.race(Queue.take(subscription), Effect.sleep(pollIntervalMs))
            : Effect.forEach(downstream, signals.wake, { discard: true }),
        ),
        Effect.catchAllCause((cause) =>
          Effect.logError(`${name} iteration failed`, cause).pipe(
            Effect.andThen(Effect.sleep(pollIntervalMs)),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped)
  })
}

export const superviseOpenCodeResumeWorker = (pollIntervalMs: number) =>
  Effect.gen(function* () {
    const worker = yield* OpenCodeResumeWorker
    return yield* superviseWorker(
      "OpenCode resume worker",
      pollIntervalMs,
      "session-resume",
      worker.iteration,
    )
  })

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

export type RuntimeWorkerName =
  "job" | "kernel-job" | "session-resume" | "publication" | "reconciliation" | "command"

export function workDownstreamLanes(lane: WorkLane): ReadonlyArray<WorkLane> {
  switch (lane) {
    case "job":
      return ["publication"]
    case "kernel-job":
    case "session-resume":
      return []
    case "publication":
    case "command":
    case "reconciliation":
      return ["job"]
  }
}

export function startHookService(
  config: AppConfig,
  observeWorkerIteration: (name: RuntimeWorkerName) => Effect.Effect<void> = () => Effect.void,
) {
  const observed = <A extends string, E, R>(
    name: RuntimeWorkerName,
    iteration: Effect.Effect<A, E, R>,
  ) => iteration.pipe(Effect.tap(() => observeWorkerIteration(name)))

  return Effect.gen(function* () {
    const automation = yield* Automation
    const signals = yield* WorkSignal
    const workflowStart = yield* Effect.serviceOption(WorkflowStart)
    const testJobCanary = yield* Effect.serviceOption(TestJobCanary)
    const resumeWorker = yield* Effect.serviceOption(OpenCodeResumeWorker)
    if (config.qrspi !== undefined && Option.isNone(workflowStart)) {
      return yield* Effect.die(new Error("QRSPI is configured without a WorkflowStart service"))
    }
    if (config.testJobCanary !== undefined && Option.isNone(testJobCanary)) {
      return yield* Effect.die(new Error("Test-job canary is configured without its service"))
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
        observed(
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
        ),
      )
    }

    yield* superviseWorker(
      "Kernel job worker",
      config.worker.pollIntervalMs,
      "kernel-job",
      observed(
        "kernel-job",
        Effect.suspend(() =>
          runKernelJobIteration({
            workerId: `${process.pid}:kernel-job`,
            now: () => new Date(),
            leaseDurationMs: config.worker.jobLeaseDurationMs,
            retryDelayMs: config.worker.pollIntervalMs,
          }),
        ).pipe(Effect.map((result) => result.status)),
      ),
    )

    if (Option.isSome(resumeWorker)) {
      yield* superviseWorker(
        "OpenCode resume worker",
        60_000,
        "session-resume",
        observed("session-resume", resumeWorker.value.iteration),
      )
    }

    yield* superviseWorker(
      "Publisher",
      config.worker.pollIntervalMs,
      "publication",
      observed(
        "publication",
        runPublicationIteration({
          workerId: `${process.pid}:publisher`,
          leaseDurationMs: config.worker.publicationLeaseDurationMs,
          timeoutMs: config.worker.publicationTimeoutMs,
          maxAttempts: 5,
          now: () => new Date(),
        }),
      ),
    )

    yield* superviseWorker(
      "Reconciliation",
      config.worker.pollIntervalMs,
      "reconciliation",
      observed(
        "reconciliation",
        runReconciliationIteration({
          workerId: `${process.pid}:reconciler`,
          leaseDurationMs: 2 * 60_000,
          maxAttempts: 5,
          now: () => new Date(),
        }),
      ),
    )

    yield* superviseWorker(
      "Command worker",
      config.worker.pollIntervalMs,
      "command",
      observed(
        "command",
        runCommandIteration({
          workerId: `${process.pid}:commands`,
          leaseDurationMs: 60_000,
          maxAttempts: 3,
          commandUsers: config.worker.commandUsers,
          fixWorkEnabled: config.fixWork.enabled,
          now: () => new Date(),
        }),
      ),
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
          ...(config.testJobCanary === undefined
            ? {}
            : {
                testJobs: {
                  token: config.testJobCanary.token,
                  submit: (input: TestJobSubmission, now: Date) =>
                    Option.getOrThrow(testJobCanary)
                      .submit(input, now)
                      .pipe(
                        Effect.tap((result) =>
                          result.newlyEnqueued ? signals.wake("kernel-job") : Effect.void,
                        ),
                      ),
                  status: Option.getOrThrow(testJobCanary).status,
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

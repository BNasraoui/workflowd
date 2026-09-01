import { Data, Effect, FiberSet, Option, PubSub } from "effect"
import type { AppConfig } from "./config"
import { normalizeError } from "./errors"
import { routeRequest, type WebhookHandlerOptions } from "./http"
import { runKernelJobIteration } from "./kernel/job-runner"
import { enqueueNextAgentHandoff } from "./kernel/agent-handoff-reducer"
import { OpenCodeCompletionSource } from "./kernel/opencode-completion-source"
import { OpenCodeResumeWorker } from "./kernel/opencode-resume-worker"
import { TestJobCanary, type TestJobSubmission } from "./kernel/test-job-canary"
import { AgentWaitIngress } from "./kernel/agent-wait-ingress"
import { AgentRunIngress } from "./kernel/agent-run-ingress"
import { AgentRunWatchdog } from "./kernel/agent-run-watchdog"
import { DogfoodStore } from "./kernel/dogfood-store"
import { AgentRunsEnrichmentStore } from "./kernel/agent-runs-enrichment-store"
import { ClaudeResumeWorker } from "./kernel/claude-resume-worker"
import { RemoteCoordinator } from "./remote/coordinator"
import type { RemoteCoordinatorError } from "./remote/coordinator-store"
import type { RemoteTransportError } from "./remote/transport"
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
            ? Effect.race(PubSub.take(subscription), Effect.sleep(pollIntervalMs))
            : Effect.forEach(downstream, signals.wake, { discard: true }),
        ),
        Effect.catchCause((cause) =>
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
                  Effect.catchCause(() =>
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
  | "job"
  | "agent-completion"
  | "agent-run"
  | "kernel-job"
  | "session-resume"
  | "publication"
  | "reconciliation"
  | "command"
  | "remote-dispatch"
  | "remote-result"

export const startRemoteCoordinatorWorkers = (
  pollIntervalMs: number,
  observe: (name: "remote-dispatch" | "remote-result") => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const coordinator = yield* RemoteCoordinator
    if (coordinator === null) {
      return yield* Effect.die(new Error("Remote coordinator service is unavailable"))
    }
    const supervise = (
      name: "remote-dispatch" | "remote-result",
      iteration: Effect.Effect<string, RemoteCoordinatorError | RemoteTransportError>,
    ) =>
      Effect.forever(
        coordinator.ensure.pipe(
          Effect.andThen(iteration),
          Effect.tap(() => observe(name)),
          Effect.andThen(name === "remote-dispatch" ? Effect.sleep(pollIntervalMs) : Effect.void),
          Effect.catchCause((cause) =>
            Effect.logError(`${name} iteration failed`, cause).pipe(
              Effect.andThen(Effect.sleep(pollIntervalMs)),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped)
    const dispatch = yield* supervise("remote-dispatch", coordinator.dispatchIteration)
    const result = yield* supervise("remote-result", coordinator.resultIteration)
    return [dispatch, result] as const
  })

export function workDownstreamLanes(lane: WorkLane): ReadonlyArray<WorkLane> {
  switch (lane) {
    case "job":
      return ["publication"]
    case "agent-completion":
      return ["kernel-job"]
    case "agent-run":
      return ["agent-completion"]
    case "kernel-job":
    case "session-resume":
      return []
    case "publication":
    case "command":
    case "reconciliation":
      return ["job"]
  }
}

/** Each optional feature must have its service(s) in the layer when its
 * config block is present; returns the first mismatch's message, or null. */
function firstMissingService(
  config: AppConfig,
  services: {
    readonly workflowStart: Option.Option<unknown>
    readonly testJobCanary: Option.Option<unknown>
    readonly agentWaits: Option.Option<unknown>
    readonly agentRuns: Option.Option<unknown>
    readonly agentRunWatchdog: Option.Option<unknown>
    readonly dogfood: Option.Option<unknown>
    readonly agentRunsEnrichment: Option.Option<unknown>
    readonly remoteCoordinator: unknown
  },
): string | null {
  if (config.qrspi !== undefined && Option.isNone(services.workflowStart)) {
    return "QRSPI is configured without a WorkflowStart service"
  }
  if (config.testJobCanary !== undefined && Option.isNone(services.testJobCanary)) {
    return "Test-job canary is configured without its service"
  }
  if (config.agentWaits !== undefined && Option.isNone(services.agentWaits)) {
    return "Agent waits are configured without their service"
  }
  if (
    config.agentRuns !== undefined &&
    (Option.isNone(services.agentRuns) || Option.isNone(services.agentRunWatchdog))
  ) {
    return "Agent runs are configured without their services"
  }
  if (config.dogfood !== undefined && Option.isNone(services.dogfood)) {
    return "Dogfood enrichment is configured without its store"
  }
  if (config.agentRunsEnrichment !== undefined && Option.isNone(services.agentRunsEnrichment)) {
    return "Agent-runs enrichment is configured without its store"
  }
  if (config.remoteCoordinator !== undefined && services.remoteCoordinator === null) {
    return "Remote coordinator is configured without its service"
  }
  return null
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
    const agentWaits = yield* Effect.serviceOption(AgentWaitIngress)
    const agentRuns = yield* Effect.serviceOption(AgentRunIngress)
    const agentRunWatchdog = yield* Effect.serviceOption(AgentRunWatchdog)
    const dogfood = yield* Effect.serviceOption(DogfoodStore)
    const agentRunsEnrichment = yield* Effect.serviceOption(AgentRunsEnrichmentStore)
    const claudeResumeWorker = yield* Effect.serviceOption(ClaudeResumeWorker)
    const resumeWorker = yield* Effect.serviceOption(OpenCodeResumeWorker)
    const completionSource = yield* Effect.serviceOption(OpenCodeCompletionSource)
    const remoteCoordinator = yield* RemoteCoordinator
    const missingService = firstMissingService(config, {
      workflowStart,
      testJobCanary,
      agentWaits,
      agentRuns,
      agentRunWatchdog,
      dogfood,
      agentRunsEnrichment,
      remoteCoordinator,
    })
    if (missingService !== null) return yield* Effect.die(new Error(missingService))

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

    if (config.remoteCoordinator !== undefined) {
      yield* startRemoteCoordinatorWorkers(config.worker.pollIntervalMs, (name) =>
        observeWorkerIteration(name),
      ).pipe(Effect.provideService(RemoteCoordinator, remoteCoordinator))
    }

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
        Effect.suspend(() => {
          const iterationAt = new Date()
          return enqueueNextAgentHandoff(iterationAt).pipe(
            Effect.andThen(
              runKernelJobIteration({
                workerId: `${process.pid}:kernel-job`,
                now: () => new Date(),
                leaseDurationMs: config.worker.jobLeaseDurationMs,
                retryDelayMs: config.worker.pollIntervalMs,
              }),
            ),
            Effect.map((result) => result.status),
          )
        }),
      ),
    )

    if (Option.isSome(completionSource)) {
      yield* superviseWorker(
        "OpenCode completion source",
        60_000,
        "agent-completion",
        observed("agent-completion", completionSource.value.iteration),
      )
    }

    if (Option.isSome(resumeWorker)) {
      yield* superviseWorker(
        "OpenCode resume worker",
        60_000,
        "session-resume",
        observed("session-resume", resumeWorker.value.iteration),
      )
    }

    if (Option.isSome(agentRunWatchdog)) {
      yield* superviseWorker(
        "Agent-run watchdog",
        60_000,
        "agent-run",
        observed("agent-run", agentRunWatchdog.value.iteration),
      )
    }

    if (Option.isSome(claudeResumeWorker)) {
      yield* superviseWorker(
        "Claude resume worker",
        60_000,
        "session-resume",
        observed("session-resume", claudeResumeWorker.value.iteration),
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
          ...(config.agentWaits === undefined
            ? {}
            : {
                agentWaits: {
                  token: config.agentWaits.token,
                  register: Option.getOrThrow(agentWaits).register,
                },
              }),
          ...(config.agentRuns === undefined
            ? {}
            : {
                agentRuns: {
                  token: config.agentRuns.token,
                  register: Option.getOrThrow(agentRuns).register,
                },
              }),
          ...(config.dogfood === undefined
            ? {}
            : {
                dogfood: {
                  token: config.dogfood.token,
                  sessions: Option.getOrThrow(dogfood).sessions,
                },
              }),
          ...(config.agentRunsEnrichment === undefined
            ? {}
            : {
                agentRunsEnrichment: {
                  token: config.agentRunsEnrichment.token,
                  sessions: Option.getOrThrow(agentRunsEnrichment).sessions,
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

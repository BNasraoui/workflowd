import { Data, Effect, FiberSet, Option } from "effect"
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
import {
  StageCatalogService,
  makeQrspiHarnessDefinitionsForStage,
  qrspiHarnessDefinitionsForWorkflows,
  validateWorkflowDefinition,
} from "./qrspi/stages"
import { runStageProduceIteration } from "./qrspi/stage-worker"
import { runArtifactPublishIteration } from "./qrspi/artifact-worker"
import { AgentHarness } from "./agent-harness"
import { QrspiStore } from "./qrspi/store"
import { ArtifactPublicationRepositoryService } from "./qrspi/artifact-publication"

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
  "job" | "publication" | "reconciliation" | "command" | "stage-produce" | "artifact-publish"

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
    const harness = yield* AgentHarness
    const workflowStart = yield* Effect.serviceOption(WorkflowStart)
    const qrspiStore = yield* Effect.serviceOption(QrspiStore)
    const stageCatalog = yield* Effect.serviceOption(StageCatalogService)
    const artifactRepository = yield* Effect.serviceOption(ArtifactPublicationRepositoryService)
    if (config.qrspi !== undefined && Option.isNone(workflowStart)) {
      return yield* Effect.die(new Error("QRSPI is configured without a WorkflowStart service"))
    }
    if (
      config.qrspi !== undefined &&
      (Option.isNone(qrspiStore) ||
        Option.isNone(stageCatalog) ||
        Option.isNone(artifactRepository))
    ) {
      return yield* Effect.die(new Error("QRSPI is configured without its worker services"))
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

    if (config.qrspi !== undefined) {
      const retainedDefinitions =
        yield* Option.getOrThrow(qrspiStore).getActiveWorkflowDefinitions()
      const activeDefinitions = [config.qrspi.workflowDefinition, ...retainedDefinitions]
      const completionMarginMs = config.qrspi.operationCompletionMarginMs
      const stageLeaseDurationMs = Math.max(
        config.qrspi.leaseDurationMs,
        ...activeDefinitions.flatMap((definition) =>
          definition.stages.map((stage) => stage.producer.timeoutMs + completionMarginMs + 1),
        ),
      )
      const retainedHarnesses = qrspiHarnessDefinitionsForWorkflows(activeDefinitions)
      harness.retainDefinitions?.(retainedHarnesses)
      for (const definition of activeDefinitions) {
        yield* Effect.try({
          try: () =>
            validateWorkflowDefinition(definition, Option.getOrThrow(stageCatalog), [
              ...retainedHarnesses,
            ]),
          catch: (cause) => new Error(`QRSPI startup catalog validation failed: ${String(cause)}`),
        })
      }
      yield* harness.validateAvailability({
        refs: [],
        policies: activeDefinitions.flatMap((definition) =>
          definition.stages
            .filter((stage) => stage.activation.mode !== "disabled")
            .map((stage) => ({
              ref: {
                name: stage.producer.harnessId,
                version: stage.producer.harnessVersion,
              },
              agent: stage.producer.agent,
              model: stage.producer.model,
            })),
        ),
        directory: config.qrspi.beadsWorkspace,
      })
      yield* superviseWorker(
        "QRSPI StageProduce worker",
        config.worker.pollIntervalMs,
        observed(
          "stage-produce",
          runStageProduceIteration({
            workerId: `${process.pid}:qrspi-stage-producer`,
            leaseDurationMs: stageLeaseDurationMs,
            directory: config.qrspi.beadsWorkspace,
            harnessDefinitions: makeQrspiHarnessDefinitionsForStage,
          }).pipe(
            Effect.provideService(QrspiStore, Option.getOrThrow(qrspiStore)),
            Effect.provideService(StageCatalogService, Option.getOrThrow(stageCatalog)),
            Effect.provideService(AgentHarness, harness),
          ),
        ),
      )
      yield* superviseWorker(
        "QRSPI ArtifactPublish worker",
        config.worker.pollIntervalMs,
        observed(
          "artifact-publish",
          runArtifactPublishIteration({
            workerId: `${process.pid}:qrspi-artifact-publisher`,
            leaseDurationMs: stageLeaseDurationMs,
          }).pipe(
            Effect.provideService(QrspiStore, Option.getOrThrow(qrspiStore)),
            Effect.provideService(
              ArtifactPublicationRepositoryService,
              Option.getOrThrow(artifactRepository),
            ),
          ),
        ),
      )
    }

    for (let index = 0; index < config.worker.concurrency; index += 1) {
      const workerId = `${process.pid}:worker:${index}`
      yield* superviseWorker(
        "Job worker",
        config.worker.pollIntervalMs,
        observed(
          "job",
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
        ),
      )
    }

    yield* superviseWorker(
      "Publisher",
      config.worker.pollIntervalMs,
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
        }),
    )
    yield* Effect.logInfo(`workflowd listening on http://${server.hostname}:${server.port}`)

    return server
  })
}

export function runHookService(config: AppConfig) {
  return Effect.scoped(startHookService(config).pipe(Effect.andThen(Effect.never)))
}

import { OpenCodeMailboxLive } from "./resident/opencode"
import { ResidentCodex, ResidentCodexLive } from "./resident/service"
import { WorkerIdentity, WorkerIdentityLive } from "./worker-identity/service"
import { CiServiceLive } from "./ci/service"
import { readFile } from "node:fs/promises"
import { SandboxDispatch, makeSandboxDispatch } from "./sandbox/dispatch"
import { makeSandboxGithub } from "./sandbox/github"
import { makeSandboxLeaseService } from "./sandbox/lease"
import { routeSandboxProvider, routeSandboxHandoffs } from "./sandbox/provider"
import { dirname, join } from "node:path"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { AgentHarness, OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "./agent-harness"
import type { AppConfig } from "./config"
import { GitHub, GitHubAppAdapter, publicSonarRequest } from "./github"
import { toJsonSchemaObject } from "./json"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "./github/adapter"
import { KernelEventStore, KernelEventStoreLive } from "./kernel/event-store"
import { AgentHandoffStore, AgentHandoffStoreLive } from "./kernel/agent-handoff-store"
import {
  AGENT_WAKE_CONTRACT,
  AGENT_WAKE_MAX_OUTPUT_BYTES,
  AgentWaitIngressLive,
  AgentWakeResult,
} from "./kernel/agent-wait-ingress"
import { KernelJobStore, KernelJobStoreLive } from "./kernel/job-store"
import { AgentRunIngressLive, AgentRunProvider } from "./kernel/agent-run-ingress"
import { AgentRunWorktrees, gitAgentRunWorktrees } from "./kernel/agent-run-worktrees"
import { AgentRunStoreLive } from "./kernel/agent-run-store"
import { AgentRunWatchdogLive } from "./kernel/agent-run-watchdog"
import { DogfoodStoreLive } from "./kernel/dogfood-store"
import { ClaudeCli, makeClaudeCli } from "./kernel/claude-session"
import { CodexCli, makeCodexCli } from "./kernel/codex-session"
import { ClaudeDispatchCli, makeClaudeDispatchCli } from "./kernel/claude-dispatch"
import { ClaudeResumeWorker, runClaudeResumeIteration } from "./kernel/claude-resume-worker"
import {
  ClaudeResumeRemoteProducer,
  ClaudeResumeRemoteProducerLive,
} from "./remote/claude-resume-producer"
import { KernelSessionStore, KernelSessionStoreLive } from "./kernel/session-store"
import {
  OpenCodeResumeAdapter,
  OpenCodeResumeProvider,
  OpenCodeResumeWorker,
  runOpenCodeResumeIteration,
} from "./kernel/opencode-resume-worker"
import {
  OpenCodeCompletionProvider,
  OpenCodeCompletionSource,
  runOpenCodeCompletionSourceIteration,
} from "./kernel/opencode-completion-source"
import { TestJobCanaryLive } from "./kernel/test-job-canary"
import { Automation, OpenCodeAutomationAdapter, makeOpenCodeHarnessDefinitions } from "./opencode"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "./opencode/adapter"
import { WorkflowStoreLive } from "./store"
import { WorkflowStore } from "./store/contracts"
import { GitWorkspaceAdapter, Workspace } from "./workspace"
import { BeadsCliTicketSource, GitHubQrspiRepository } from "./qrspi/adapters"
import { WorkflowDefinitionValidationError } from "./qrspi/domain"
import { QrspiRepository, TicketSource } from "./qrspi/ports"
import { QrspiStoreDataError, QrspiStoreLive } from "./qrspi/store"
import { makeWorkspaceSourceResolver } from "./qrspi/source-resolver"
import {
  WorkflowStart,
  WorkflowStartLive,
  WorkflowStartUnauthorized,
  closedWorkflowStart,
  toWorkflowStartValidationError,
} from "./qrspi/workflow-start"
import { StageCatalog, StageCatalogError, TrustedStageCatalog } from "./qrspi/stage-catalog"
import { builtInStageContracts } from "./qrspi/contracts"
import { SessionAccessResolver } from "./session-access"
import { WorkSignal, WorkSignalLive } from "./work-signal"
import { RemoteCoordinatorLive } from "./remote/coordinator"
import { RemoteCoordinatorStoreLive } from "./remote/coordinator-store"
import { RemoteTransportLive } from "./remote/transport"
import { ExecutionDiscovery, makeExecutionCapabilities } from "./execution-capabilities"
import { localDiscoverySources } from "./execution/local"

const resumeContract = <A, I>(definition: {
  readonly ref: { readonly name: string; readonly version: number }
  readonly outputSchema: Schema.Codec<A, I>
  readonly model: string
  readonly agent: string
  readonly maxOutputBytes: number
}) => {
  const separator = definition.model.indexOf("/")
  return {
    name: definition.ref.name,
    version: definition.ref.version,
    schema: definition.outputSchema,
    jsonSchema: toJsonSchemaObject(definition.outputSchema),
    agent: definition.agent,
    model: {
      providerID: definition.model.slice(0, separator),
      modelID: definition.model.slice(separator + 1),
    },
    maxOutputBytes: definition.maxOutputBytes,
  }
}

const stageResumeContract = <A, I>(
  contract: {
    readonly ref: { readonly name: string; readonly contractVersion: number }
    readonly resultSchema: Schema.Codec<A, I>
    readonly maxResultBytes: number
  },
  harness: ReturnType<typeof makeOpenCodeHarnessDefinitions>["stage"],
) =>
  resumeContract({
    ref: { name: contract.ref.name, version: contract.ref.contractVersion },
    outputSchema: contract.resultSchema,
    model: harness.model,
    agent: harness.agent,
    maxOutputBytes: contract.maxResultBytes,
  })

function makeDiscoveryLayer(
  config: AppConfig,
  client?: Parameters<typeof localDiscoverySources>[1],
) {
  const executionDiscoveryConfig = config.executionCapabilities
  return executionDiscoveryConfig === undefined
    ? Layer.empty
    : Layer.effect(
        ExecutionDiscovery,
        Effect.gen(function* () {
          const discovery = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeExecutionCapabilities({
                host: config.worker.hostId,
                sources: localDiscoverySources(config, client),
                refreshMs: executionDiscoveryConfig.refreshMs,
                timeoutMs: executionDiscoveryConfig.timeoutMs,
              }),
            ),
            (resource) =>
              Effect.tryPromise({
                try: () => resource.close(),
                catch: () => new Error("Capability discovery cleanup failed"),
              }).pipe(Effect.orDie),
          )
          return ExecutionDiscovery.of({
            list: Effect.fn("ExecutionDiscovery.list")(() =>
              Effect.tryPromise({
                try: () => discovery.list(),
                catch: () => new Error("Capability discovery unavailable"),
              }),
            ),
          })
        }),
      )
}

function makeExecutionOnlyLayer(config: AppConfig) {
  const kernel = Layer.mergeAll(
    KernelEventStoreLive,
    KernelJobStoreLive,
    KernelSessionStoreLive,
    DogfoodStoreLive,
    Layer.effect(SqlClient.SqlClient, SqlClient.SqlClient),
  ).pipe(Layer.provideMerge(WorkflowStoreLive))
  const store = AgentRunStoreLive.pipe(Layer.provideMerge(kernel))
  const signals = WorkSignalLive
  const codex = Layer.succeed(
    CodexCli,
    makeCodexCli({
      binary: config.agentRuns?.codexBinary ?? "codex",
      custodyRoot: join(dirname(config.storage.databasePath), "agent-processes"),
      ...(config.agentRuns?.codexUnitPrefix === undefined
        ? {}
        : { unitPrefix: config.agentRuns.codexUnitPrefix }),
    }),
  )
  const claude =
    (config.agentRuns?.claudeRoutes.length ?? 0) === 0
      ? Layer.empty
      : Layer.succeed(
          ClaudeDispatchCli,
          makeClaudeDispatchCli({
            binary: config.agentRuns?.claudeBinary ?? "claude",
            custodyRoot: join(dirname(config.storage.databasePath), "claude-processes"),
          }),
        )
  const discovery = makeDiscoveryLayer(config)
  const identity = {
    owningHostId: config.worker.hostId,
    providerId: "native-local",
    serverId: config.worker.hostId,
    endpointAlias: "local",
    endpointIdentity: `local://${config.worker.hostId}`,
    providerVersion: 1,
  }
  const runs =
    config.agentRuns === undefined
      ? Layer.empty
      : AgentRunIngressLive({
          ...config.agentRuns,
          identity,
          worktreeRoot: config.workspace.worktreeRoot,
        }).pipe(
          Layer.provideMerge(store),
          Layer.provideMerge(codex),
          Layer.provideMerge(claude),
          Layer.provideMerge(discovery),
          Layer.provideMerge(signals),
          Layer.provide(Layer.succeed(AgentRunWorktrees, gitAgentRunWorktrees)),
        )
  return Layer.mergeAll(
    kernel,
    store,
    signals,
    discovery,
    runs,
    Layer.succeed(WorkflowStart, {
      preflight: Effect.void,
      start: () =>
        Effect.fail(new WorkflowStartUnauthorized({ reason: "QRSPI ingress is disabled" })),
    }),
  )
}

const makeAutomationLayer = (config: Extract<AppConfig, { readonly mode?: "automation" }>) => {
  const authorization = Buffer.from(
    `${config.openCode.username}:${config.openCode.password}`,
  ).toString("base64")
  const openCodeHttpLayer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("authorization", `Basic ${authorization}`),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const openCodeClientEffect = Effect.runSync(
    Effect.cached(
      OpenCode.make({ baseUrl: config.openCode.baseUrl }).pipe(Effect.provide(openCodeHttpLayer)),
    ),
  )
  const openCodeAdapter = new SdkOpenCodeAdapter(makeOpenCodeSdkClient(openCodeClientEffect))
  const executionDiscoveryLayer = makeDiscoveryLayer(config, openCodeClientEffect)
  const definitions = makeOpenCodeHarnessDefinitions({
    ...config.openCode,
    timeoutMs: config.worker.jobTimeoutMs,
  })
  const resumeProvider = new OpenCodeResumeAdapter(openCodeAdapter)
  const completionSourceOptions = {
    owningHostId: config.worker.hostId,
    providerId: config.openCode.serverId,
    serverId: config.openCode.serverId,
    endpointAlias: config.openCode.endpointAlias,
    endpointIdentity: config.openCode.baseUrl,
    providerVersion: 1,
    // Bounds one live-stream observation so a still-running child yields its
    // completion-source slot to newer watches instead of holding it open.
    observationTimeoutMs: 30_000,
    now: () => new Date(),
  }
  const resumeContracts = [
    resumeContract(definitions.review),
    resumeContract(definitions.fix),
    // Generic wake contract for agent handoffs registered through the
    // wait_for_agent tool and POST /workflows/agent-waits. The parent only has
    // to acknowledge; it is not being asked to produce domain output.
    resumeContract({
      ref: AGENT_WAKE_CONTRACT,
      outputSchema: AgentWakeResult,
      model: config.openCode.model,
      agent: config.openCode.agentWakeAgent,
      maxOutputBytes: AGENT_WAKE_MAX_OUTPUT_BYTES,
    }),
    stageResumeContract(builtInStageContracts[0], definitions.stage),
    stageResumeContract(builtInStageContracts[1], definitions.stage),
    stageResumeContract(builtInStageContracts[2], definitions.stage),
    stageResumeContract(builtInStageContracts[3], definitions.stage),
    stageResumeContract(builtInStageContracts[4], definitions.stage),
    stageResumeContract(builtInStageContracts[5], definitions.stage),
  ]
  const agentHarness = new OpenCodeAgentHarness(
    openCodeAdapter,
    new TrustedAgentHarnessCatalog(Object.values(definitions)),
    {
      serverId: config.openCode.serverId,
      endpointAlias: config.openCode.endpointAlias,
      pollIntervalMs: config.openCode.pollIntervalMs,
    },
  )
  const sessionAccess = new SessionAccessResolver(openCodeAdapter, {
    serverId: config.openCode.serverId,
    endpointAlias: config.openCode.endpointAlias,
    attachUrl: config.openCode.attachUrl,
  })
  const stageCatalogLayer = Layer.effect(
    StageCatalog,
    Effect.try({
      try: () => new TrustedStageCatalog(builtInStageContracts).port(),
      catch: (cause) =>
        cause instanceof StageCatalogError
          ? cause
          : new StageCatalogError({
              reason: "malformed_registration",
              reference: "<catalog>",
              cause: String(cause),
            }),
    }),
  )
  const kernelStoreLayer = Layer.mergeAll(
    KernelEventStoreLive,
    KernelJobStoreLive,
    KernelSessionStoreLive,
    DogfoodStoreLive,
    Layer.effect(SqlClient.SqlClient, SqlClient.SqlClient),
  ).pipe(Layer.provideMerge(WorkflowStoreLive))
  const agentHandoffStoreLayer = AgentHandoffStoreLive.pipe(Layer.provideMerge(kernelStoreLayer))
  const storeLayer = Layer.merge(kernelStoreLayer, agentHandoffStoreLayer)
  const providerLayer = Layer.merge(
    Layer.succeed(OpenCodeResumeProvider, resumeProvider),
    Layer.succeed(OpenCodeCompletionProvider, resumeProvider),
  )
  const workSignalLayer = WorkSignalLive
  const resumeWorkerLayer = Layer.effect(
    OpenCodeResumeWorker,
    Effect.gen(function* () {
      const sessions = yield* KernelSessionStore
      const provider = yield* OpenCodeResumeProvider
      const sql = yield* SqlClient.SqlClient
      return {
        iteration: runOpenCodeResumeIteration({
          owningHostId: config.worker.hostId,
          workerId: `${process.pid}:opencode-resume`,
          providerId: config.openCode.serverId,
          serverId: config.openCode.serverId,
          endpointAlias: config.openCode.endpointAlias,
          endpointIdentity: config.openCode.baseUrl,
          providerVersion: 1,
          leaseDurationMs: config.worker.jobLeaseDurationMs,
          heartbeatIntervalMs: Math.max(1_000, Math.floor(config.worker.jobLeaseDurationMs / 3)),
          now: () => new Date(),
          contracts: resumeContracts,
        }).pipe(
          Effect.provideService(KernelSessionStore, sessions),
          Effect.provideService(OpenCodeResumeProvider, provider),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.map((result) => result.status),
        ),
      }
    }),
  ).pipe(Layer.provideMerge(storeLayer), Layer.provideMerge(providerLayer))
  const completionSourceLayer = Layer.effect(
    OpenCodeCompletionSource,
    Effect.gen(function* () {
      const provider = yield* OpenCodeCompletionProvider
      const events = yield* KernelEventStore
      const sql = yield* SqlClient.SqlClient
      const signals = yield* WorkSignal
      return {
        iteration: runOpenCodeCompletionSourceIteration(completionSourceOptions).pipe(
          Effect.provideService(OpenCodeCompletionProvider, provider),
          Effect.provideService(KernelEventStore, events),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(WorkSignal, signals),
          Effect.map((result) => result.status),
        ),
      }
    }),
  ).pipe(
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(workSignalLayer),
  )
  const testJobCanaryLayer = TestJobCanaryLive.pipe(Layer.provideMerge(storeLayer))
  const agentWaitIngressLayer = AgentWaitIngressLive(completionSourceOptions).pipe(
    Layer.provide(
      Layer.effect(AgentHandoffStore, routeSandboxHandoffs).pipe(Layer.provide(storeLayer)),
    ),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(workSignalLayer),
  )
  const claudeCliLayer = Layer.succeed(
    ClaudeCli,
    makeClaudeCli({ binary: config.agentRuns?.claudeBinary ?? "claude" }),
  )
  const workerIdentityLayer =
    config.workerIdentity === undefined
      ? Layer.empty
      : WorkerIdentityLive(config.workerIdentity, config.github).pipe(
          Layer.provide(AgentRunStoreLive.pipe(Layer.provide(storeLayer))),
        )
  const ciLive =
    config.ci === undefined
      ? undefined
      : CiServiceLive(config.ci, config.github).pipe(Layer.provide(storeLayer))
  const ciLayer = ciLive ?? Layer.empty
  const residentLive =
    config.residentCodex === undefined || config.ci === undefined || ciLive === undefined
      ? undefined
      : ResidentCodexLive(
          {
            ...config.residentCodex,
            progressWindowMs: config.agentRuns?.progressWindowMs,
            unitPrefix:
              config.agentRuns?.codexUnitPrefix === undefined
                ? "workflowd-resident-"
                : `${config.agentRuns.codexUnitPrefix}resident-`,
          },
          config.agentRuns?.codexBinary ?? "codex",
          config.ci,
        ).pipe(
          Layer.provide(ciLive),
          Layer.provide(workerIdentityLayer),
          Layer.provide(AgentRunStoreLive.pipe(Layer.provide(storeLayer))),
          Layer.provide(storeLayer),
        )
  const openCodeMailboxLayer =
    config.residentOpenCodeSocket === undefined || config.ci === undefined || ciLive === undefined
      ? Layer.empty
      : OpenCodeMailboxLive(
          {
            ...completionSourceOptions,
            socket: config.residentOpenCodeSocket,
            repositories: config.ci.repositories,
          },
          openCodeAdapter,
        ).pipe(
          Layer.provide(ciLive),
          Layer.provide(AgentRunStoreLive.pipe(Layer.provide(storeLayer))),
          Layer.provide(storeLayer),
        )
  const residentLayer = residentLive ?? Layer.empty
  const claudeDispatchLayer = Layer.succeed(
    ClaudeDispatchCli,
    makeClaudeDispatchCli({
      binary: config.agentRuns?.claudeBinary ?? "claude",
      custodyRoot: join(dirname(config.storage.databasePath), "claude-processes"),
    }),
  )
  const codexCliLayer =
    residentLive === undefined
      ? Layer.effect(
          CodexCli,
          Effect.gen(function* () {
            const identity = yield* Effect.serviceOption(WorkerIdentity)
            return makeCodexCli({
              binary: config.agentRuns?.codexBinary ?? "codex",
              ...(config.agentRuns?.codexUnitPrefix === undefined
                ? {}
                : { unitPrefix: config.agentRuns.codexUnitPrefix }),
              custodyRoot: join(dirname(config.storage.databasePath), "agent-processes"),
              ...(Option.isSome(identity) ? { identity: identity.value } : {}),
            })
          }),
        ).pipe(Layer.provide(workerIdentityLayer))
      : Layer.effect(
          CodexCli,
          Effect.map(ResidentCodex, (resident) => resident.cli),
        ).pipe(Layer.provideMerge(residentLive))

  const claudeResumeWorkerLayer =
    config.agentRuns === undefined
      ? Layer.empty
      : Layer.effect(
          ClaudeResumeWorker,
          Effect.gen(function* () {
            const sessions = yield* KernelSessionStore
            const jobs = yield* KernelJobStore
            const sql = yield* SqlClient.SqlClient
            const cli = yield* ClaudeCli
            const remoteProducer = yield* ClaudeResumeRemoteProducer
            const agentRuns = config.agentRuns!
            return {
              iteration: runClaudeResumeIteration({
                owningHostId: config.worker.hostId,
                workerId: `${process.pid}:claude-resume`,
                leaseDurationMs: config.worker.jobLeaseDurationMs,
                heartbeatIntervalMs: Math.max(
                  1_000,
                  Math.floor(config.worker.jobLeaseDurationMs / 3),
                ),
                resumeTimeoutMs: 5 * 60_000,
                retryDelayMs: 30_000,
                claudeHosts: agentRuns.claudeHosts,
                remoteTurnTimeoutMs: agentRuns.remoteTurnTimeoutMs,
                now: () => new Date(),
                contracts: resumeContracts,
              }).pipe(
                Effect.provideService(KernelSessionStore, sessions),
                Effect.provideService(KernelJobStore, jobs),
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.provideService(ClaudeCli, cli),
                Effect.provideService(ClaudeResumeRemoteProducer, remoteProducer),
                Effect.map((result) => result.status),
              ),
            }
          }),
        ).pipe(
          Layer.provideMerge(
            ClaudeResumeRemoteProducerLive.pipe(Layer.provideMerge(kernelStoreLayer)),
          ),
          Layer.provideMerge(kernelStoreLayer),
          Layer.provideMerge(claudeCliLayer),
        )
  const sandboxPolicies = config.agentRuns?.sandboxRepositories ?? []
  const sandboxLayer =
    sandboxPolicies.length === 0
      ? Layer.empty
      : Layer.effect(
          SandboxDispatch,
          Effect.gen(function* () {
            const github = yield* makeSandboxGithub(config.github)
            const leases = yield* makeSandboxLeaseService(github)
            return yield* makeSandboxDispatch({
              policies: sandboxPolicies,
              github,
              leases,
              executor: openCodeAdapter,
              client: yield* openCodeClientEffect,
              executorId: `opencode:${completionSourceOptions.providerId}`,
              endpointIdentity: completionSourceOptions.endpointIdentity,
            })
          }),
        ).pipe(Layer.provideMerge(AgentRunStoreLive.pipe(Layer.provideMerge(kernelStoreLayer))))
  const sandboxProviderLayer =
    sandboxPolicies.length === 0
      ? Layer.succeed(AgentRunProvider, openCodeAdapter)
      : Layer.effect(
          AgentRunProvider,
          Effect.gen(function* () {
            const sandbox = yield* Effect.serviceOption(SandboxDispatch)
            if (Option.isNone(sandbox))
              return yield* Effect.fail(new Error("Configured sandbox service is unavailable"))
            return yield* routeSandboxProvider(openCodeAdapter, sandbox.value)
          }),
        ).pipe(Layer.provideMerge(sandboxLayer), Layer.provideMerge(kernelStoreLayer))
  const agentRunLayer =
    config.agentRuns === undefined
      ? Layer.empty
      : Layer.merge(
          AgentRunIngressLive({
            routes: config.agentRuns.routes,
            codexRoutes: config.agentRuns.codexRoutes,
            claudeRoutes: config.agentRuns.claudeRoutes,
            repositories: config.agentRuns.repositories,
            sandboxRepositories: config.agentRuns.sandboxRepositories ?? [],
            agent: config.agentRuns.agent,
            worktreeRoot: config.workspace.worktreeRoot,
            verifyTimeoutMs: config.agentRuns.verifyTimeoutMs,
            verifyPollIntervalMs: config.agentRuns.verifyPollIntervalMs,
            progressWindowMs: config.agentRuns.progressWindowMs,
            maxAttempts: config.agentRuns.maxAttempts,
            claudeHosts: config.agentRuns.claudeHosts,
            identity: completionSourceOptions,
          }),
          AgentRunWatchdogLive({
            progressWindowMs: config.agentRuns.progressWindowMs,
            // A run stuck before verification for ten verify windows was
            // abandoned by its dispatching request; the watchdog fails it.
            staleAfterMs: config.agentRuns.verifyTimeoutMs * 10,
            // Codex runs complete inline in the dispatching request; their
            // verified rows are invisible to the watchdog.
            unsupervisedExecutorKinds: ["codex", "claude"],
            now: () => new Date(),
          }),
        ).pipe(
          Layer.provideMerge(AgentRunStoreLive.pipe(Layer.provideMerge(kernelStoreLayer))),
          Layer.provideMerge(agentWaitIngressLayer),
          Layer.provideMerge(sandboxProviderLayer),
          Layer.provideMerge(Layer.succeed(AgentRunWorktrees, gitAgentRunWorktrees)),
          Layer.provideMerge(claudeCliLayer),
          Layer.provideMerge(codexCliLayer),
          Layer.provideMerge(executionDiscoveryLayer),
          Layer.provideMerge(claudeDispatchLayer),
          Layer.provideMerge(workerIdentityLayer),
          Layer.provideMerge(openCodeMailboxLayer),
          Layer.provideMerge(workSignalLayer),
        )
  const qrspiLayer =
    config.qrspi === undefined
      ? Layer.succeed(WorkflowStart, {
          preflight: Effect.void,
          start: () =>
            Effect.fail(new WorkflowStartUnauthorized({ reason: "QRSPI ingress is disabled" })),
        })
      : WorkflowStartLive({
          binding: {
            repository: config.qrspi.repository,
            trackerInstanceId: config.qrspi.trackerInstanceId,
          },
          baseRef: config.qrspi.baseRef,
          repositoryOperationTimeoutMs: config.qrspi.repositoryOperationTimeoutMs,
          operationCompletionMarginMs: config.qrspi.operationCompletionMarginMs,
          leaseDurationMs: config.qrspi.leaseDurationMs,
          workflowDefinition: config.qrspi.workflowDefinition,
          sourceResolver: makeWorkspaceSourceResolver(config.qrspi.beadsWorkspace),
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              QrspiStoreLive,
              Layer.succeed(AgentHarness, agentHarness),
              stageCatalogLayer,
              Layer.succeed(
                TicketSource,
                new BeadsCliTicketSource(
                  config.qrspi.beadsWorkspace,
                  config.qrspi.trackerInstanceId,
                ),
              ),
              Layer.effect(
                QrspiRepository,
                Effect.gen(function* () {
                  const store = yield* WorkflowStore
                  const privateKey = yield* Effect.tryPromise({
                    try: () => readFile(config.github.privateKeyPath, "utf8"),
                    catch: (cause) =>
                      new Error(`Could not read GitHub App private key: ${String(cause)}`),
                  })
                  return new GitHubQrspiRepository(
                    config.qrspi!,
                    (installationId) => {
                      const app = new App({
                        appId: config.github.appId,
                        privateKey,
                        Octokit,
                      })
                      return app.getInstallationOctokit(installationId)
                    },
                    (publication) => {
                      const signingKey = config.workspace.gitSigningKey
                      if (signingKey === undefined) return Promise.resolve(null)
                      return Effect.runPromise(
                        store.isTrustedBranchPublication({
                          repositoryId: publication.repository.repositoryId,
                          repositoryFullName: publication.repository.repositoryFullName,
                          headRef: publication.headRef,
                          jobId: publication.jobId,
                          commitSha: publication.commitSha,
                          controllerSigningFingerprint: signingKey.toLowerCase(),
                        }),
                      )
                    },
                  )
                }),
              ),
            ),
          ),
          Layer.catchCause((cause) => {
            const error = Option.getOrUndefined(Cause.findErrorOption(cause))
            return error instanceof WorkflowDefinitionValidationError ||
              error instanceof QrspiStoreDataError ||
              error instanceof StageCatalogError
              ? Layer.succeed(
                  WorkflowStart,
                  closedWorkflowStart(toWorkflowStartValidationError(error)),
                )
              : Layer.effect(WorkflowStart, Effect.failCause(cause))
          }),
        )
  const qrspiWithStores = qrspiLayer.pipe(Layer.provideMerge(storeLayer))
  const remoteCoordinatorLayer =
    config.remoteCoordinator === undefined
      ? Layer.empty
      : RemoteCoordinatorLive(config.remoteCoordinator).pipe(
          Layer.provideMerge(RemoteCoordinatorStoreLive.pipe(Layer.provideMerge(storeLayer))),
          Layer.provideMerge(
            RemoteTransportLive({
              servers: config.remoteCoordinator.servers,
              auth: config.remoteCoordinator.auth,
            }),
          ),
        )
  return Layer.mergeAll(
    executionDiscoveryLayer,
    ciLayer,
    residentLayer,
    workerIdentityLayer,
    workSignalLayer,
    providerLayer,
    resumeWorkerLayer,
    completionSourceLayer,
    Layer.effect(
      GitHub,
      Effect.tryPromise({
        try: () => readFile(config.github.privateKeyPath, "utf8"),
        catch: (cause) => new Error(`Could not read GitHub App private key: ${String(cause)}`),
      }).pipe(
        Effect.map((privateKey) => {
          const app = new App({
            appId: config.github.appId,
            privateKey,
            Octokit,
          })
          return new GitHubAppAdapter(
            config.github.appId,
            async (installationId) =>
              new OctokitInstallationAdapter(
                makeOctokitClientPort(await app.getInstallationOctokit(installationId)),
              ),
            {
              resolve: (reference) => sessionAccess.resolve(reference),
            },
            publicSonarRequest,
          )
        }),
      ),
    ),
    Layer.succeed(AgentHarness, agentHarness),
    Layer.succeed(Automation, new OpenCodeAutomationAdapter(agentHarness, definitions)),
    Layer.succeed(Workspace, new GitWorkspaceAdapter(config.workspace)),
    qrspiWithStores,
    testJobCanaryLayer,
    agentWaitIngressLayer,
    agentRunLayer,
    claudeResumeWorkerLayer,
    remoteCoordinatorLayer,
  )
}

export function makeLiveLayer(
  config: Extract<AppConfig, { readonly mode?: "automation" }>,
): ReturnType<typeof makeAutomationLayer>
export function makeLiveLayer(
  config: Extract<AppConfig, { readonly mode: "execution" }>,
): ReturnType<typeof makeExecutionOnlyLayer>
export function makeLiveLayer(
  config: AppConfig,
): ReturnType<typeof makeAutomationLayer> | ReturnType<typeof makeExecutionOnlyLayer>
export function makeLiveLayer(config: AppConfig) {
  return config.mode === "execution" ? makeExecutionOnlyLayer(config) : makeAutomationLayer(config)
}

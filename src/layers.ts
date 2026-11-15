import { makeMessagingLayer } from "./messaging/layers"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Cause, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AgentHarness } from "./agent-harness"
import { CiServiceLive } from "./ci/service"
import type { AppConfig } from "./config"
import { AgentHandoffStore, AgentHandoffStoreLive } from "./kernel/agent-handoff-store"
import { AgentRunIngressLive, AgentRunProvider } from "./kernel/agent-run-ingress"
import { AgentRunStoreLive } from "./kernel/agent-run-store"
import { AgentRunWatchdogLive } from "./kernel/agent-run-watchdog"
import { agentRunWorktreeJanitorLayer } from "./kernel/agent-run-worktree-janitor"
import { AgentRunWorktrees, agentRunWorktrees } from "./kernel/agent-run-worktrees"
import { AgentWaitIngressLive } from "./kernel/agent-wait-ingress"
import { ClaudeDispatchCli, makeClaudeDispatchCli } from "./kernel/claude-dispatch"
import { ClaudeResumeWorker, runClaudeResumeIteration } from "./kernel/claude-resume-worker"
import { ClaudeCli, makeClaudeCli } from "./kernel/claude-session"
import { CodexCli, makeCodexCli } from "./kernel/codex-session"
import { DogfoodStoreLive } from "./kernel/dogfood-store"
import { KernelEventStore, KernelEventStoreLive } from "./kernel/event-store"
import { KernelJobStore, KernelJobStoreLive } from "./kernel/job-store"
import {
  OpenCodeCompletionProvider,
  OpenCodeCompletionSource,
  runOpenCodeCompletionSourceIteration,
} from "./kernel/opencode-completion-source"
import {
  OpenCodeResumeProvider,
  OpenCodeResumeWorker,
  runOpenCodeResumeIteration,
} from "./kernel/opencode-resume-worker"
import { KernelSessionStore, KernelSessionStoreLive } from "./kernel/session-store"
import { TestJobCanaryLive } from "./kernel/test-job-canary"
import { Automation, OpenCodeAutomationAdapter } from "./opencode"
import { BeadsCliTicketSource, GitHubQrspiRepository } from "./qrspi/adapters"
import { builtInStageContracts } from "./qrspi/contracts"
import { WorkflowDefinitionValidationError } from "./qrspi/domain"
import { QrspiRepository, TicketSource } from "./qrspi/ports"
import { makeWorkspaceSourceResolver } from "./qrspi/source-resolver"
import { StageCatalog, StageCatalogError, TrustedStageCatalog } from "./qrspi/stage-catalog"
import { QrspiStoreDataError, QrspiStoreLive } from "./qrspi/store"
import {
  WorkflowStart,
  WorkflowStartLive,
  WorkflowStartUnauthorized,
  closedWorkflowStart,
  toWorkflowStartValidationError,
} from "./qrspi/workflow-start"
import {
  ClaudeResumeRemoteProducer,
  ClaudeResumeRemoteProducerLive,
} from "./remote/claude-resume-producer"
import { RemoteCoordinatorLive } from "./remote/coordinator"
import { RemoteCoordinatorStoreLive } from "./remote/coordinator-store"
import { RemoteTransportLive } from "./remote/transport"
import { OpenCodeMailboxLive } from "./resident/opencode"
import { ResidentCodex, ResidentCodexLive } from "./resident/service"
import { reviewServerId } from "./review-harness"
import { SandboxDispatch, makeSandboxDispatch } from "./sandbox/dispatch"
import { makeSandboxGithub } from "./sandbox/github"
import { makeSandboxLeaseService } from "./sandbox/lease"
import { routeSandboxHandoffs, routeSandboxProvider } from "./sandbox/provider"
import { WorkflowStoreLive } from "./store"
import { WorkflowStore } from "./store/contracts"
import { WorkSignal, WorkSignalLive } from "./work-signal"
import { loadRunSocketPolicy } from "./worker-identity/peer"
import { WorkerIdentity, WorkerIdentityLive } from "./worker-identity/service"
import { GitWorkspaceAdapter, Workspace } from "./workspace"

import { makeGitHubLayer } from "./github/layer"
import { makeDiscoveryLayer, makeExecutionOnlyLayer } from "./layers-execution"
import { makeOpenCodeComposition } from "./layers-opencode"
import { makeDirectoryLayer, makeDirectoryRemoteLayer } from "./directory/layers"
import { DirectoryStoreLive } from "./directory/store"
import { DirectoryRemoteStoreLive } from "./directory/remote-store"
import { ManagedDirectoryObservationsLive } from "./directory/managed-observations"

function makeManagedDirectoryObservationLayer(
  config: Extract<AppConfig, { readonly mode?: "automation" }>,
) {
  return config.executionCapabilities === undefined
    ? Layer.empty
    : ManagedDirectoryObservationsLive({
        hostId: config.worker.hostId,
        endpointIdentity: config.openCode.baseUrl,
        refreshMs: config.directoryRemote?.refreshMs ?? 30_000,
        leaseMs: config.directoryRemote?.leaseMs ?? 90_000,
        now: () => new Date(),
      })
}

const makeAutomationLayer = (config: Extract<AppConfig, { readonly mode?: "automation" }>) => {
  const {
    openCodeAdapter,
    openCodeClientEffect,
    definitions,
    resumeProvider,
    completionSourceOptions,
    resumeContracts,
    agentHarness,
    reviewAccess,
    sessionAccess,
  } = makeOpenCodeComposition(config)
  const executionDiscoveryLayer = makeDiscoveryLayer(config, openCodeClientEffect)
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
  const directoryStores = Layer.merge(DirectoryStoreLive, DirectoryRemoteStoreLive).pipe(
    Layer.provide(kernelStoreLayer),
  )
  const directoryLayer = makeDirectoryLayer(config).pipe(
    Layer.provideMerge(directoryStores),
    Layer.provide(executionDiscoveryLayer),
  )
  const directoryObservations = makeDirectoryRemoteLayer(config).pipe(
    Layer.provide(directoryStores),
  )
  const messaging = makeMessagingLayer(config).pipe(
    Layer.provide(directoryLayer),
    Layer.provide(directoryStores),
    Layer.provide(kernelStoreLayer),
  )
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
  const workerIdentityLayer =
    config.workerIdentity === undefined
      ? Layer.empty
      : WorkerIdentityLive(config.workerIdentity, config.github, undefined, {
          ...completionSourceOptions,
          setSessionEnvironment: openCodeAdapter.setSessionEnvironment,
        }).pipe(
          Layer.provide(storeLayer),
          Layer.provide(AgentRunStoreLive.pipe(Layer.provide(storeLayer))),
        )
  const claudeCliLayer = Layer.effect(
    ClaudeCli,
    Effect.gen(function* () {
      const identity = yield* Effect.serviceOption(WorkerIdentity)
      return makeClaudeCli({
        credentialSocket: config.credentialSocket,
        git: config.agentGit,
        binary: config.agentRuns?.claudeBinary ?? "claude",
        ...(Option.isSome(identity) ? { identity: identity.value } : {}),
      })
    }),
  ).pipe(Layer.provide(workerIdentityLayer))
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
            credentialSocket: config.credentialSocket,
            git: config.agentGit,
            progressWindowMs: config.agentRuns?.progressWindowMs,
            directoryRefreshMs: config.directoryRemote?.refreshMs ?? 30_000,
            directoryLeaseMs: config.directoryRemote?.leaseMs ?? 90_000,
            unitPrefix:
              config.agentRuns?.codexUnitPrefix === undefined
                ? "workflowd-resident-"
                : `${config.agentRuns.codexUnitPrefix}resident-`,
          },
          config.agentRuns?.codexBinary ?? "codex",
          config.ci,
        ).pipe(
          Layer.provide(ciLive),
          Layer.provide(messaging),
          Layer.provide(workerIdentityLayer),
          Layer.provide(directoryLayer),
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
            peer: config.workerIdentity?.peer ?? loadRunSocketPolicy(process.env),
            repositories: config.ci.repositories,
          },
          openCodeAdapter,
        ).pipe(
          Layer.provide(ciLive),
          Layer.provide(messaging),
          Layer.provide(AgentRunStoreLive.pipe(Layer.provide(storeLayer))),
          Layer.provide(storeLayer),
        )
  const residentLayer = residentLive ?? Layer.empty
  const claudeDispatchLayer = Layer.effect(
    ClaudeDispatchCli,
    Effect.gen(function* () {
      const identity = yield* Effect.serviceOption(WorkerIdentity)
      return makeClaudeDispatchCli({
        ...(Option.isSome(identity) ? { identity: identity.value } : {}),
        credentialSocket: config.credentialSocket,
        git: config.agentGit,
        binary: config.agentRuns?.claudeBinary ?? "claude",
        custodyRoot: join(dirname(config.storage.databasePath), "claude-processes"),
      })
    }),
  ).pipe(Layer.provide(workerIdentityLayer))
  const codexCliLayer =
    residentLive === undefined
      ? Layer.effect(
          CodexCli,
          Effect.gen(function* () {
            const identity = yield* Effect.serviceOption(WorkerIdentity)
            return makeCodexCli({
              credentialSocket: config.credentialSocket,
              git: config.agentGit,
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
              nativeExecutors: {
                codex: makeCodexCli({
                  credentialSocket: config.credentialSocket,
                  git: config.agentGit,
                  binary: config.agentRuns?.codexBinary ?? "codex",
                  custodyRoot: join(
                    dirname(config.storage.databasePath),
                    "sandbox-codex-processes",
                  ),
                  unitPrefix: "workflowd-sandbox-codex-",
                }),
                claude: makeClaudeDispatchCli({
                  credentialSocket: config.credentialSocket,
                  git: config.agentGit,
                  binary: config.agentRuns?.claudeBinary ?? "claude",
                  custodyRoot: join(
                    dirname(config.storage.databasePath),
                    "sandbox-claude-processes",
                  ),
                  unitPrefix: "workflowd-sandbox-claude-",
                }),
              },
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
  const managedDirectoryObservations = makeManagedDirectoryObservationLayer(config).pipe(
    Layer.provide(directoryStores),
    Layer.provide(sandboxProviderLayer),
  )
  const agentRunLayer =
    config.agentRuns === undefined
      ? Layer.empty
      : Layer.mergeAll(
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
            directoryLeaseMs: config.directoryRemote?.leaseMs ?? 90_000,
            // Codex runs complete inline in the dispatching request; their
            // verified rows are invisible to the watchdog.
            unsupervisedExecutorKinds: ["codex", "claude"],
            now: () => new Date(),
          }),
          agentRunWorktreeJanitorLayer(config, config.agentRuns),
        ).pipe(
          Layer.provideMerge(directoryLayer),
          Layer.provideMerge(AgentRunStoreLive.pipe(Layer.provideMerge(kernelStoreLayer))),
          Layer.provideMerge(agentWaitIngressLayer),
          Layer.provideMerge(sandboxProviderLayer),
          Layer.provideMerge(
            Layer.succeed(AgentRunWorktrees, {
              create: (input) =>
                agentRunWorktrees(config.credentialSocket).create({
                  ...input,
                  git: config.agentGit,
                }),
            }),
          ),
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
    directoryLayer,
    directoryObservations,
    messaging,
    managedDirectoryObservations,
    ciLayer,
    residentLayer,
    workerIdentityLayer,
    workSignalLayer,
    providerLayer,
    resumeWorkerLayer,
    completionSourceLayer,
    makeGitHubLayer(config, {
      resolve: (reference) =>
        (reference.serverId === reviewServerId ? reviewAccess : sessionAccess).resolve(reference),
    }),
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

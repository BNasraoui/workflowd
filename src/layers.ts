import { readFile } from "node:fs/promises"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { SqlClient } from "@effect/sql"
import { Effect, JSONSchema, Layer, Schema } from "effect"
import { AgentHarness, OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "./agent-harness"
import type { AppConfig } from "./config"
import { GitHub, GitHubAppAdapter, publicSonarRequest } from "./github"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "./github/adapter"
import { KernelEventStore, KernelEventStoreLive } from "./kernel/event-store"
import { AgentHandoffStoreLive } from "./kernel/agent-handoff-store"
import { KernelJobStoreLive } from "./kernel/job-store"
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

const resumeContract = <A, I>(definition: {
  readonly ref: { readonly name: string; readonly version: number }
  readonly outputSchema: Schema.Schema<A, I, never>
  readonly model: string
  readonly agent: string
  readonly maxOutputBytes: number
}) => {
  const separator = definition.model.indexOf("/")
  return {
    name: definition.ref.name,
    version: definition.ref.version,
    schema: definition.outputSchema,
    jsonSchema: JSONSchema.make(definition.outputSchema),
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
    readonly resultSchema: Schema.Schema<A, I, never>
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

export const makeLiveLayer = (config: AppConfig) => {
  const authorization = Buffer.from(
    `${config.openCode.username}:${config.openCode.password}`,
  ).toString("base64")
  const openCodeClient = createOpencodeClient({
    baseUrl: config.openCode.baseUrl,
    headers: { Authorization: `Basic ${authorization}` },
    throwOnError: true,
  })
  const openCodeAdapter = new SdkOpenCodeAdapter(makeOpenCodeSdkClient(openCodeClient))
  const definitions = makeOpenCodeHarnessDefinitions({
    ...config.openCode,
    timeoutMs: config.worker.jobTimeoutMs,
  })
  const resumeProvider = new OpenCodeResumeAdapter(openCodeAdapter)
  const resumeContracts = [
    resumeContract(definitions.review),
    resumeContract(definitions.fix),
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
    Layer.service(SqlClient.SqlClient),
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
        iteration: runOpenCodeCompletionSourceIteration({
          owningHostId: config.worker.hostId,
          providerId: config.openCode.serverId,
          serverId: config.openCode.serverId,
          endpointAlias: config.openCode.endpointAlias,
          endpointIdentity: config.openCode.baseUrl,
          providerVersion: 1,
          now: () => new Date(),
        }).pipe(
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
                    async (installationId) => {
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
          Layer.catchAll((error) =>
            error instanceof WorkflowDefinitionValidationError ||
            error instanceof QrspiStoreDataError ||
            error instanceof StageCatalogError
              ? Layer.succeed(
                  WorkflowStart,
                  closedWorkflowStart(toWorkflowStartValidationError(error)),
                )
              : Layer.fail(error),
          ),
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
              token: config.remoteCoordinator.token,
            }),
          ),
        )
  return Layer.mergeAll(
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
    remoteCoordinatorLayer,
  )
}

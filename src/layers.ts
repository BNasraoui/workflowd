import { readFile } from "node:fs/promises"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Effect, Layer } from "effect"
import { AgentHarness, OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "./agent-harness"
import type { AppConfig } from "./config"
import { GitHub, GitHubAppAdapter } from "./github"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "./github/adapter"
import {
  Automation,
  OpenCodeAutomationAdapter,
  makePullRequestHarnessDefinitions,
} from "./opencode"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "./opencode/adapter"
import { WorkflowStoreLive } from "./store"
import { WorkflowStore } from "./store/contracts"
import { GitWorkspaceAdapter, Workspace } from "./workspace"
import { BeadsCliTicketSource, GitHubQrspiRepository } from "./qrspi/adapters"
import { QrspiRepository, TicketSource } from "./qrspi/ports"
import { QrspiStore, QrspiStoreLive } from "./qrspi/store"
import { makeWorkspaceSourceResolver } from "./qrspi/source-resolver"
import { WorkflowStart, WorkflowStartLive, WorkflowStartUnauthorized } from "./qrspi/workflow-start"
import {
  ArtifactPublicationRepositoryFactoryService,
  GitArtifactPublicationRepository,
} from "./qrspi/artifact-publication"
import { GitQrspiWorkspace, QrspiWorkspace } from "./qrspi/workspace"
import {
  BuiltInStageContracts,
  StageCatalog,
  StageCatalogService,
  qrspiHarnessDefinitionsForWorkflows,
  validateWorkflowDefinition,
} from "./qrspi/stages"

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
  const definitions = makePullRequestHarnessDefinitions({
    ...config.openCode,
    timeoutMs: config.worker.jobTimeoutMs,
  })
  const qrspiDefinitions =
    config.qrspi === undefined
      ? []
      : qrspiHarnessDefinitionsForWorkflows([config.qrspi.workflowDefinition])
  const stageCatalog = new StageCatalog(BuiltInStageContracts)
  if (config.qrspi !== undefined) {
    validateWorkflowDefinition(config.qrspi.workflowDefinition, stageCatalog, [...qrspiDefinitions])
  }
  const agentHarness = new OpenCodeAgentHarness(
    openCodeAdapter,
    new TrustedAgentHarnessCatalog([definitions.review, definitions.fix, ...qrspiDefinitions]),
    {
      serverId: config.openCode.serverId,
      endpointAlias: config.openCode.endpointAlias,
      pollIntervalMs: config.openCode.pollIntervalMs,
    },
  )
  const qrspiLayer =
    config.qrspi === undefined
      ? Layer.succeed(WorkflowStart, {
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
                  const qrspiStore = yield* QrspiStore
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
                      if ("controllerId" in publication) {
                        return Effect.runPromise(
                          qrspiStore.isTrustedArtifactPublication({
                            repository: publication.repository,
                            headRef: publication.headRef,
                            controllerId: publication.controllerId,
                            operationId: publication.operationId,
                            commitSha: publication.commitSha,
                          }),
                        )
                      }
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
                }).pipe(Effect.provide(Layer.merge(WorkflowStoreLive, QrspiStoreLive))),
              ),
            ),
          ),
        )
  const artifactRepositoryLayer =
    config.qrspi !== undefined && config.workspace.gitSigningKey !== undefined
      ? Layer.succeed(ArtifactPublicationRepositoryFactoryService, {
          forDirectory: (directory) =>
            new GitArtifactPublicationRepository(directory, config.workspace.gitSigningKey!),
        })
      : Layer.empty
  const qrspiWorkspaceLayer =
    config.qrspi === undefined
      ? Layer.empty
      : Layer.succeed(
          QrspiWorkspace,
          new GitQrspiWorkspace(config.qrspi.beadsWorkspace, config.workspace.worktreeRoot),
        )
  return Layer.mergeAll(
    WorkflowStoreLive,
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
          )
        }),
      ),
    ),
    Layer.succeed(AgentHarness, agentHarness),
    Layer.succeed(Automation, new OpenCodeAutomationAdapter(agentHarness, definitions)),
    Layer.succeed(Workspace, new GitWorkspaceAdapter(config.workspace)),
    Layer.succeed(StageCatalogService, stageCatalog),
    artifactRepositoryLayer,
    qrspiWorkspaceLayer,
    qrspiLayer,
  )
}

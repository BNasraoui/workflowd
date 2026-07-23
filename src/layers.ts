import { readFile } from "node:fs/promises"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Effect, Layer } from "effect"
import { AgentHarness, OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "./agent-harness"
import type { AppConfig } from "./config"
import { GitHub, GitHubAppAdapter } from "./github"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "./github/adapter"
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
import { StageCatalog, TrustedStageCatalog, questionsStageContract } from "./qrspi/stage-catalog"
import { SessionAccessResolver } from "./session-access"

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
  const stageCatalog = new TrustedStageCatalog([questionsStageContract])
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
              Layer.succeed(StageCatalog, stageCatalog.port()),
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
                }).pipe(Effect.provide(WorkflowStoreLive)),
              ),
            ),
          ),
          Layer.catchAll((error) =>
            error instanceof WorkflowDefinitionValidationError ||
            error instanceof QrspiStoreDataError
              ? Layer.succeed(
                  WorkflowStart,
                  closedWorkflowStart(toWorkflowStartValidationError(error)),
                )
              : Layer.fail(error),
          ),
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
            {
              resolve: (reference) => sessionAccess.resolve(reference),
            },
          )
        }),
      ),
    ),
    Layer.succeed(AgentHarness, agentHarness),
    Layer.succeed(StageCatalog, stageCatalog.port()),
    Layer.succeed(Automation, new OpenCodeAutomationAdapter(agentHarness, definitions)),
    Layer.succeed(Workspace, new GitWorkspaceAdapter(config.workspace)),
    qrspiLayer,
  )
}

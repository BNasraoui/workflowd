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
import { GitWorkspaceAdapter, Workspace } from "./workspace"

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
  const agentHarness = new OpenCodeAgentHarness(
    openCodeAdapter,
    new TrustedAgentHarnessCatalog([definitions.review, definitions.fix]),
    {
      serverId: config.openCode.serverId,
      endpointAlias: config.openCode.endpointAlias,
      pollIntervalMs: config.openCode.pollIntervalMs,
    },
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
  )
}

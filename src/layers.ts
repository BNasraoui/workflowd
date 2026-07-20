import { readFile } from "node:fs/promises"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Effect, Layer } from "effect"
import type { AppConfig } from "./config"
import { GitHub, GitHubAppAdapter } from "./github"
import {
  makeOctokitClientPort,
  OctokitInstallationAdapter,
} from "./github/adapter"
import { Automation, OpenCodeAutomationAdapter } from "./opencode"
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
  return Layer.mergeAll(
    WorkflowStoreLive,
    Layer.effect(
      GitHub,
      Effect.tryPromise({
        try: () => readFile(config.github.privateKeyPath, "utf8"),
        catch: (cause) =>
          new Error(`Could not read GitHub App private key: ${String(cause)}`),
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
                makeOctokitClientPort(
                  await app.getInstallationOctokit(installationId),
                ),
              ),
          )
        }),
      ),
    ),
    Layer.succeed(
      Automation,
      new OpenCodeAutomationAdapter(
        new SdkOpenCodeAdapter(makeOpenCodeSdkClient(openCodeClient)),
        config.openCode,
      ),
    ),
    Layer.succeed(Workspace, new GitWorkspaceAdapter(config.workspace)),
  )
}

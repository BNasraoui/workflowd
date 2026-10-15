import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Context, Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import type { AppConfig } from "../config"
import { GitHub, GitHubAppAdapter, publicSonarRequest } from "../github"
import { InstallationGuard, makeInstallationGuard } from "../installation-guard"
import type { SessionAccessResolver } from "../session-access"
import { makeOctokitClientPort, OctokitInstallationAdapter } from "./adapter"

export const makeGitHubLayer = (
  config: Extract<AppConfig, { readonly mode?: "automation" }>,
  sessionAccess: Pick<SessionAccessResolver, "resolve">,
) =>
  Layer.effectContext(
    Effect.tryPromise({
      try: () => readFile(config.github.privateKeyPath, "utf8"),
      catch: (cause) => new Error(`Could not read GitHub App private key: ${String(cause)}`),
    }).pipe(
      Effect.flatMap(
        Effect.fn(function* (privateKey: string) {
          const app = new App({
            appId: config.github.appId,
            privateKey,
            Octokit,
          })
          const github = new GitHubAppAdapter(
            config.github.appId,
            async (installationId) =>
              new OctokitInstallationAdapter(
                makeOctokitClientPort(await app.getInstallationOctokit(installationId)),
              ),
            sessionAccess,
            publicSonarRequest,
            config.agentGit?.blockedEmails,
          )
          return Context.make(GitHub, github).pipe(
            Context.add(
              InstallationGuard,
              yield* makeInstallationGuard(
                config.github.allowedInstallationAccountIds,
                app.octokit,
              ),
            ),
          )
        }),
      ),
    ),
  )

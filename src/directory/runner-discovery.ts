import { Effect, Layer, Redacted } from "effect"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ExecutionDiscovery, makeExecutionCapabilities } from "../execution-capabilities"
import { makeCodexDiscovery } from "../execution/codex"
import { makeOpenCodeDiscovery } from "../execution/opencode"
import type { DirectoryRunnerConfig } from "./config"

export const RunnerDiscoveryLive = (
  hostId: string,
  config: DirectoryRunnerConfig,
  claudeEnabled: boolean,
) =>
  Layer.effect(
    ExecutionDiscovery,
    Effect.gen(function* () {
      const openCode = config.openCode
      const client =
        openCode === undefined
          ? undefined
          : yield* OpenCode.make({ baseUrl: openCode.baseUrl }).pipe(
              Effect.provide(
                Layer.effect(
                  HttpClient.HttpClient,
                  Effect.map(HttpClient.HttpClient, (client) =>
                    HttpClient.mapRequest(
                      client,
                      HttpClientRequest.setHeader(
                        "authorization",
                        `Basic ${Buffer.from(`${openCode.username}:${Redacted.value(openCode.password)}`).toString("base64")}`,
                      ),
                    ),
                  ),
                ).pipe(Layer.provide(FetchHttpClient.layer)),
              ),
            )
      const discovery = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeExecutionCapabilities({
            host: hostId,
            refreshMs: 30_000,
            timeoutMs: 10_000,
            sources: [
              ...(client === undefined || openCode === undefined
                ? []
                : [makeOpenCodeDiscovery(`opencode:${openCode.serverId}`, Effect.succeed(client))]),
              ...(config.codexEnabled
                ? [
                    makeCodexDiscovery("codex:local", {
                      command: [config.codexBinary, "app-server", "--listen", "stdio://"],
                    }),
                  ]
                : []),
              ...(claudeEnabled
                ? [
                    {
                      executor: "claude:local",
                      kind: "claude",
                      protocol: "unsupported",
                      discover: () => Promise.resolve({ status: "unsupported" as const }),
                    },
                  ]
                : []),
            ],
          }),
        ),
        (resource) => Effect.tryPromise(() => resource.close()).pipe(Effect.orDie),
      )
      return ExecutionDiscovery.of({
        list: Effect.fn("RunnerDiscovery.list")(() =>
          Effect.tryPromise({
            try: () => discovery.list(),
            catch: () => new Error("Runner discovery unavailable"),
          }),
        ),
      })
    }),
  )

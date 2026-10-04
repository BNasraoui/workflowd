import { dirname, join } from "node:path"
import { OpenCode } from "@opencode-ai/client/effect"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { WorkflowStoreLive } from "../store"
import { AgentRunIngressLive, AgentRunProvider } from "../kernel/agent-run-ingress"
import { AgentRunStoreLive } from "../kernel/agent-run-store"
import { KernelSessionStoreLive } from "../kernel/session-store"
import { AgentRunWorktrees, gitAgentRunWorktrees } from "../kernel/agent-run-worktrees"
import { CodexCli, makeCodexCli } from "../kernel/codex-session"
import { ClaudeDispatchCli, makeClaudeDispatchCli } from "../kernel/claude-dispatch"
import { AgentRunWatchdogLive } from "../kernel/agent-run-watchdog"
import { WorkSignalLive } from "../work-signal"
import { SdkOpenCodeAdapter, makeOpenCodeSdkClient } from "../opencode/adapter"
import { RemoteAgentRunnerLive } from "./agent-runner"
import type { RemoteProcessConfig } from "./config"
import type { RemoteTransportError } from "./transport"
import type { CliProcessOptions } from "../kernel/codex-session"

export const runnerAgentLayer = <E>(
  config: RemoteProcessConfig,
  database: Layer.Layer<SqlClient.SqlClient, E>,
  transport: Layer.Layer<import("./transport").RemoteTransportPort, RemoteTransportError>,
  options: {
    readonly nativeOptions?: Pick<
      CliProcessOptions,
      "runCommand" | "pollIntervalMs" | "observationTimeoutMs"
    >
  } = {},
) => {
  const execution = config.agentExecution
  if (execution === undefined) return Layer.empty
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  const stores = Layer.merge(AgentRunStoreLive, KernelSessionStoreLive).pipe(
    Layer.provideMerge(bootstrap),
    Layer.provideMerge(WorkSignalLive),
  )
  const custodyRoot = join(dirname(config.databasePath), "agent-processes")
  const native = Layer.mergeAll(
    Layer.succeed(
      CodexCli,
      makeCodexCli({ ...options.nativeOptions, binary: execution.codexBinary, custodyRoot }),
    ),
    Layer.succeed(
      ClaudeDispatchCli,
      makeClaudeDispatchCli({ ...options.nativeOptions, binary: config.claudeBinary, custodyRoot }),
    ),
    Layer.succeed(AgentRunWorktrees, gitAgentRunWorktrees),
  )
  const http = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader(
          "authorization",
          `Basic ${Buffer.from(`opencode:${execution.openCodePassword}`).toString("base64")}`,
        ),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer))
  const makeProvider = (url: string) =>
    Layer.effect(
      AgentRunProvider,
      Effect.gen(function* () {
        const client = yield* Effect.cached(
          OpenCode.make({ baseUrl: url }).pipe(Effect.provide(http)),
        )
        return new SdkOpenCodeAdapter(makeOpenCodeSdkClient(client))
      }),
    )
  const provider =
    execution.openCodeUrl === undefined ? Layer.empty : makeProvider(execution.openCodeUrl)
  const ingress = AgentRunIngressLive({
    scopeNativeCompletions: true,
    routes: [],
    codexRoutes: [],
    claudeRoutes: [],
    repositories: execution.repositories,
    agent: "build",
    worktreeRoot: execution.worktreeRoot,
    verifyTimeoutMs: execution.verifyTimeoutMs,
    verifyPollIntervalMs: 2000,
    progressWindowMs: execution.progressWindowMs,
    maxAttempts: 3,
    claudeHosts: [],
    identity: {
      owningHostId: config.hostId,
      providerId: "opencode-runner",
      providerVersion: 1,
      serverId: config.hostId,
      endpointAlias: "runner-local",
      endpointIdentity: execution.openCodeUrl ?? `runner://${config.hostId}`,
    },
  }).pipe(Layer.provideMerge(stores), Layer.provideMerge(native), Layer.provideMerge(provider))
  const supervised =
    execution.openCodeUrl === undefined
      ? ingress
      : Layer.merge(
          ingress,
          AgentRunWatchdogLive({
            progressWindowMs: execution.progressWindowMs,
            staleAfterMs: execution.verifyTimeoutMs * 10,
            unsupervisedExecutorKinds: ["codex", "claude"],
            now: () => new Date(),
          }),
        ).pipe(Layer.provideMerge(stores), Layer.provideMerge(makeProvider(execution.openCodeUrl)))
  return RemoteAgentRunnerLive(config.hostId).pipe(
    Layer.provideMerge(supervised),
    Layer.provideMerge(transport),
  )
}

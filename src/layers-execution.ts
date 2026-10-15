import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { dirname, join } from "node:path"
import type { AppConfig } from "./config"
import { ExecutionDiscovery, makeExecutionCapabilities } from "./execution-capabilities"
import { localDiscoverySources } from "./execution/local"
import { AgentRunIngressLive } from "./kernel/agent-run-ingress"
import { AgentRunStoreLive } from "./kernel/agent-run-store"
import { AgentRunWorktrees, agentRunWorktrees } from "./kernel/agent-run-worktrees"
import { ClaudeDispatchCli, makeClaudeDispatchCli } from "./kernel/claude-dispatch"
import { CodexCli, makeCodexCli } from "./kernel/codex-session"
import { DogfoodStoreLive } from "./kernel/dogfood-store"
import { KernelEventStoreLive } from "./kernel/event-store"
import { KernelJobStoreLive } from "./kernel/job-store"
import { KernelSessionStoreLive } from "./kernel/session-store"
import { WorkflowStart, WorkflowStartUnauthorized } from "./qrspi/workflow-start"
import { WorkflowStoreLive } from "./store"
import { WorkSignalLive } from "./work-signal"

export function makeDiscoveryLayer(
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

export function makeExecutionOnlyLayer(config: AppConfig) {
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
      credentialSocket: config.credentialSocket,
      git: config.agentGit,
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
            credentialSocket: config.credentialSocket,
            git: config.agentGit,
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
          Layer.provide(
            Layer.succeed(AgentRunWorktrees, {
              create: (input) =>
                agentRunWorktrees(config.credentialSocket).create({
                  ...input,
                  git: config.agentGit,
                }),
            }),
          ),
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

import { OpenCode } from "@opencode-ai/client/effect"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { dirname, join } from "node:path"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "./agent-harness"
import type { AppConfig } from "./config"
import { ExecutionDiscovery, makeExecutionCapabilities } from "./execution-capabilities"
import { localDiscoverySources } from "./execution/local"
import { toJsonSchemaObject } from "./json"
import { AgentRunIngressLive } from "./kernel/agent-run-ingress"
import { AgentRunStoreLive } from "./kernel/agent-run-store"
import { AgentRunWorktrees, agentRunWorktrees } from "./kernel/agent-run-worktrees"
import {
  AGENT_WAKE_CONTRACT,
  AGENT_WAKE_MAX_OUTPUT_BYTES,
  AgentWakeResult,
} from "./kernel/agent-wait-ingress"
import { ClaudeDispatchCli, makeClaudeDispatchCli } from "./kernel/claude-dispatch"
import { CodexCli, makeCodexCli } from "./kernel/codex-session"
import { DogfoodStoreLive } from "./kernel/dogfood-store"
import { KernelEventStoreLive } from "./kernel/event-store"
import { KernelJobStoreLive } from "./kernel/job-store"
import { OpenCodeResumeAdapter } from "./kernel/opencode-resume-worker"
import { KernelSessionStoreLive } from "./kernel/session-store"
import { makeOpenCodeHarnessDefinitions } from "./opencode"
import { SdkOpenCodeAdapter, makeOpenCodeSdkClient } from "./opencode/adapter"
import { builtInStageContracts } from "./qrspi/contracts"
import { WorkflowStart, WorkflowStartUnauthorized } from "./qrspi/workflow-start"
import { reviewEndpointAlias, reviewServerId, routeReviewHarness } from "./review-harness"
import { SessionAccessResolver } from "./session-access"
import { WorkflowStoreLive } from "./store"
import { WorkSignalLive } from "./work-signal"

const resumeContract = <A, I>(definition: {
  readonly ref: { readonly name: string; readonly version: number }
  readonly outputSchema: Schema.Codec<A, I>
  readonly model: string
  readonly agent: string
  readonly maxOutputBytes: number
}) => {
  const separator = definition.model.indexOf("/")
  return {
    name: definition.ref.name,
    version: definition.ref.version,
    schema: definition.outputSchema,
    jsonSchema: toJsonSchemaObject(definition.outputSchema),
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
    readonly resultSchema: Schema.Codec<A, I>
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

function makeDiscoveryLayer(
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

export const makeHarnessAdapters = (
  config: Extract<AppConfig, { readonly mode?: "automation" }>,
) => {
  const openCodeHttpLayer = (password: string) =>
    Layer.effect(
      HttpClient.HttpClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        HttpClient.mapRequest(
          client,
          HttpClientRequest.setHeader(
            "authorization",
            `Basic ${Buffer.from(`${config.openCode.username}:${password}`).toString("base64")}`,
          ),
        ),
      ),
    ).pipe(Layer.provide(FetchHttpClient.layer))
  const openCodeClientEffect = Effect.runSync(
    Effect.cached(
      OpenCode.make({ baseUrl: config.openCode.baseUrl }).pipe(
        Effect.provide(openCodeHttpLayer(config.openCode.password)),
      ),
    ),
  )
  const openCodeAdapter = new SdkOpenCodeAdapter(
    makeOpenCodeSdkClient(openCodeClientEffect, config.credentialSocket),
    config.agentGit,
  )
  const executionDiscoveryLayer = makeDiscoveryLayer(config, openCodeClientEffect)
  const definitions = makeOpenCodeHarnessDefinitions({
    ...config.openCode,
    timeoutMs: config.worker.jobTimeoutMs,
  })
  const resumeProvider = new OpenCodeResumeAdapter(openCodeAdapter)
  const completionSourceOptions = {
    owningHostId: config.worker.hostId,
    providerId: config.openCode.serverId,
    serverId: config.openCode.serverId,
    endpointAlias: config.openCode.endpointAlias,
    endpointIdentity: config.openCode.baseUrl,
    providerVersion: 1,
    // Bounds one live-stream observation so a still-running child yields its
    // completion-source slot to newer watches instead of holding it open.
    observationTimeoutMs: 30_000,
    now: () => new Date(),
  }
  const resumeContracts = [
    resumeContract(definitions.review),
    resumeContract(definitions.fix),
    // Generic wake contract for agent handoffs registered through the
    // wait_for_agent tool and POST /workflows/agent-waits. The parent only has
    // to acknowledge; it is not being asked to produce domain output.
    resumeContract({
      ref: AGENT_WAKE_CONTRACT,
      outputSchema: AgentWakeResult,
      model: config.openCode.model,
      agent: config.openCode.agentWakeAgent,
      maxOutputBytes: AGENT_WAKE_MAX_OUTPUT_BYTES,
    }),
    stageResumeContract(builtInStageContracts[0], definitions.stage),
    stageResumeContract(builtInStageContracts[1], definitions.stage),
    stageResumeContract(builtInStageContracts[2], definitions.stage),
    stageResumeContract(builtInStageContracts[3], definitions.stage),
    stageResumeContract(builtInStageContracts[4], definitions.stage),
    stageResumeContract(builtInStageContracts[5], definitions.stage),
  ]
  const sharedHarness = new OpenCodeAgentHarness(
    openCodeAdapter,
    new TrustedAgentHarnessCatalog(Object.values(definitions)),
    {
      serverId: config.openCode.serverId,
      endpointAlias: config.openCode.endpointAlias,
      pollIntervalMs: config.openCode.pollIntervalMs,
    },
  )
  const reviewClient = Effect.runSync(
    Effect.cached(
      OpenCode.make({
        baseUrl: config.credentialSocket ? config.openCode.baseUrl : config.openCode.reviewUrl,
      }).pipe(
        Effect.provide(
          openCodeHttpLayer(
            config.credentialSocket ? config.openCode.password : config.openCode.reviewPassword,
          ),
        ),
      ),
    ),
  )
  const reviewAdapter = new SdkOpenCodeAdapter(
    makeOpenCodeSdkClient(reviewClient, config.credentialSocket),
    config.agentGit,
  )
  const reviewHarness = new OpenCodeAgentHarness(
    reviewAdapter,
    new TrustedAgentHarnessCatalog([definitions.review, definitions.fix]),
    {
      serverId: reviewServerId,
      endpointAlias: reviewEndpointAlias,
      pollIntervalMs: config.openCode.pollIntervalMs,
    },
  )
  // Agent-host deployments use the one migrated server for every new OpenCode run.
  const agentHarness = config.credentialSocket
    ? sharedHarness
    : routeReviewHarness(sharedHarness, reviewHarness)
  const reviewAccess = new SessionAccessResolver(reviewAdapter, {
    serverId: reviewServerId,
    endpointAlias: reviewEndpointAlias,
    attachUrl: config.credentialSocket ? config.openCode.attachUrl : config.openCode.reviewUrl,
  })
  const sessionAccess = new SessionAccessResolver(openCodeAdapter, {
    serverId: config.openCode.serverId,
    endpointAlias: config.openCode.endpointAlias,
    attachUrl: config.openCode.attachUrl,
  })
  return {
    openCodeAdapter,
    openCodeClientEffect,
    executionDiscoveryLayer,
    definitions,
    resumeProvider,
    completionSourceOptions,
    resumeContracts,
    agentHarness,
    reviewAccess,
    sessionAccess,
  }
}

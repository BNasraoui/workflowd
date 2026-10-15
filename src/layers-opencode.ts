import { OpenCode } from "@opencode-ai/client/effect"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "./agent-harness"
import type { AppConfig } from "./config"
import { toJsonSchemaObject } from "./json"
import {
  AGENT_WAKE_CONTRACT,
  AGENT_WAKE_MAX_OUTPUT_BYTES,
  AgentWakeResult,
} from "./kernel/agent-wait-ingress"
import { OpenCodeResumeAdapter } from "./kernel/opencode-resume-worker"
import { makeOpenCodeHarnessDefinitions } from "./opencode"
import { SdkOpenCodeAdapter, makeOpenCodeSdkClient } from "./opencode/adapter"
import { builtInStageContracts } from "./qrspi/contracts"
import { reviewEndpointAlias, reviewServerId, routeReviewHarness } from "./review-harness"
import { SessionAccessResolver } from "./session-access"

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

export function makeOpenCodeComposition(
  config: Extract<AppConfig, { readonly mode?: "automation" }>,
) {
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
    config.openCode.baseUrl,
  )
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
    config.credentialSocket ? config.openCode.baseUrl : config.openCode.reviewUrl,
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
    openCodeClientEffect,
    openCodeAdapter,
    definitions,
    resumeProvider,
    completionSourceOptions,
    resumeContracts,
    agentHarness,
    reviewAccess,
    sessionAccess,
  }
}

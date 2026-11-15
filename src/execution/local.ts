import { withCredentialAdmissionPromise } from "../agent-host/client"
import type { OpenCodeClient } from "@opencode-ai/client/effect"
import type { Effect } from "effect"
import type { AppConfig } from "../config"
import type { DiscoverySource } from "../execution-capabilities"
import { makeCodexDiscovery } from "./codex"
import { makeOpenCodeDiscovery } from "./opencode"

export function localDiscoverySources(
  config: AppConfig,
  client?: Effect.Effect<OpenCodeClient, Error>,
): ReadonlyArray<DiscoverySource> {
  const sources: DiscoverySource[] = [
    ...(config.openCode === undefined || client === undefined
      ? []
      : [makeOpenCodeDiscovery(`opencode:${config.openCode.serverId}`, client)]),
  ]
  if (config.executionCapabilities?.codexEnabled)
    sources.push(
      makeCodexDiscovery("codex:local", {
        credentialSocket: config.credentialSocket,
        command: [config.executionCapabilities.codexBinary, "app-server", "--listen", "stdio://"],
        ...(config.residentCodex === undefined ? {} : { home: config.residentCodex.home }),
      }),
    )
  if (config.agentRuns !== undefined)
    sources.push({
      executor: "claude:local",
      kind: "claude",
      protocol: "unsupported",
      discover: () => Promise.resolve({ status: "unsupported" }),
    })
  const local = sources.map((source) => ({
    ...source,
    checkCredentials: () =>
      withCredentialAdmissionPromise(
        config.credentialSocket,
        source.kind === "codex" ? "codex" : source.kind === "claude" ? "claude" : "opencode",
        () => Promise.resolve(),
      ),
    discover: (signal: AbortSignal) =>
      withCredentialAdmissionPromise(
        config.credentialSocket,
        source.kind === "codex" ? "codex" : source.kind === "claude" ? "claude" : "opencode",
        () => source.discover(signal),
      ),
  }))
  const runs = config.agentRuns
  if (
    !runs?.capabilityGateway ||
    !runs.sandboxRepositories?.some((policy) => policy.privateBootstrap?.mode === "actions-native")
  )
    return local
  const gateway = runs.capabilityGateway
  if (gateway.native) {
    const kind = gateway.native.protocol === "codex-chatgpt" ? "codex" : "opencode"
    return [
      ...local,
      {
        executor: `${kind}:actions`,
        host: "github-actions",
        kind,
        protocol: gateway.native.protocol,
        evidence: "configured",
        discover: () =>
          Promise.resolve(
            gateway
              .native!.models.filter((model) => kind !== "codex" || model.id === "gpt-5.5")
              .map((model) => ({
                provider: gateway.providerId,
                model: model.id,
                availability: "unknown" as const,
                thinkingStatus: "configured" as const,
                efforts: model.efforts.map((id) => ({ id })),
                ...(model.efforts[0] === undefined
                  ? {}
                  : { defaultEffort: model.efforts.includes("high") ? "high" : model.efforts[0] }),
                ...(kind === "opencode"
                  ? { variants: model.efforts.map((effort) => ({ id: effort, effort })) }
                  : {}),
                tools: true,
                responsesWebsockets: false,
              })),
          ),
      },
    ]
  }
  if (gateway.providerId !== "anthropic") return local
  // These are configured choices, not subscription entitlement or native model
  // discovery. Gateway admission owns credentials; the local CLI is irrelevant.
  return [
    ...local,
    {
      executor: "claude:actions",
      host: "github-actions",
      kind: "claude",
      protocol: "configured-interactive",
      evidence: "configured",
      discover: () =>
        Promise.resolve(
          [
            ...new Set(
              runs.claudeRoutes.flatMap((route) => (route.modelID === null ? [] : [route.modelID])),
            ),
          ].map((model) => ({ provider: "anthropic", model, availability: "unknown" as const })),
        ),
    },
  ]
}

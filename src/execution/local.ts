import type { OpenCodeClient } from "@opencode-ai/client/effect"
import type { Effect } from "effect"
import type { AppConfig } from "../config"
import type { DiscoverySource } from "../execution-capabilities"
import { makeCodexDiscovery } from "./codex"
import { makeOpenCodeDiscovery } from "./opencode"

export function localDiscoverySources(
  config: AppConfig,
  client: Effect.Effect<OpenCodeClient, Error>,
): ReadonlyArray<DiscoverySource> {
  const sources: DiscoverySource[] = [
    makeOpenCodeDiscovery(`opencode:${config.openCode.serverId}`, client),
  ]
  if (config.executionCapabilities?.codexEnabled)
    sources.push(
      makeCodexDiscovery("codex:local", {
        command: [config.executionCapabilities.codexBinary, "app-server", "--listen", "stdio://"],
        ...(config.residentCodex === undefined ? {} : { home: config.residentCodex.home }),
      }),
    )
  if (config.agentRuns?.claudeHosts.includes(config.worker.hostId))
    sources.push({
      executor: "claude:local",
      kind: "claude",
      protocol: "unsupported",
      discover: () => Promise.resolve({ status: "unsupported" }),
    })
  return sources
}

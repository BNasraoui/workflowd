import type { OpenCodeClient } from "@opencode-ai/client/effect"
import type { Effect } from "effect"
import type { AppConfig } from "../config"
import type { DiscoverySource } from "../execution-capabilities"
import { makeCodexDiscovery } from "./codex"
import { makeOpenCodeDiscovery } from "./opencode"
import { makeClaudeDiscovery } from "./claude"

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
        command: [config.executionCapabilities.codexBinary, "app-server", "--listen", "stdio://"],
        ...(config.residentCodex === undefined ? {} : { home: config.residentCodex.home }),
      }),
    )
  if (config.executionCapabilities?.claudeEnabled)
    sources.push(
      makeClaudeDiscovery("claude:local", config.executionCapabilities?.claudeBinary ?? "claude"),
    )
  return sources
}

import { describe, expect, test } from "bun:test"
import {
  SdkOpenCodeAdapter,
  type OpenCodeSdkClient,
} from "../../src/opencode/adapter"

function availabilityAdapter(
  agents: ReadonlyArray<string>,
  models: ReadonlyArray<string>,
) {
  const client = {
    createSession: async () => ({ id: "unused" }),
    promptSession: async () => undefined,
    subscribeEvents: async () => (async function* () {})(),
    getSessionStatuses: async () => ({}),
    listSessionMessages: async () => [],
    abortSession: async () => true,
    listAgents: async () => agents,
    listProviders: async () => [
      { id: "anthropic", modelIDs: models },
    ],
  } satisfies OpenCodeSdkClient
  return new SdkOpenCodeAdapter(client)
}

const requested = {
  agents: ["pr-reviewer", "pr-fixer"],
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
}

describe("OpenCodeAdapter.validateAvailability", () => {
  test("accepts configured agents and a configured provider model", async () => {
    const adapter = availabilityAdapter(
      ["pr-reviewer", "pr-fixer", "general"],
      ["claude-sonnet-4-6"],
    )

    await expect(
      adapter.validateAvailability(requested, new AbortController().signal),
    ).resolves.toBeUndefined()
  })

  test("reports every unavailable configured integration", async () => {
    const adapter = availabilityAdapter(
      ["pr-reviewer"],
      ["claude-haiku-4-5"],
    )

    await expect(
      adapter.validateAvailability(requested, new AbortController().signal),
    ).rejects.toThrow(
      "Unavailable OpenCode integration: agent pr-fixer, model anthropic/claude-sonnet-4-6",
    )
  })
})

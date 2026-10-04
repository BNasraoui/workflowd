import { expect, test } from "bun:test"
import { loadConfig } from "../../src/config"
import { Effect } from "effect"
import { localDiscoverySources } from "../../src/execution/local"
import { loadExecutionCapabilitiesDaemon } from "../../src/mcp/auth"

const env = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY_PATH: "/fixture/key",
  GITHUB_WEBHOOK_SECRET: "secret",
  OPENCODE_SERVER_PASSWORD: "secret",
  WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
  WORKFLOWD_HOST_ID: "box",
}

test("local discovery can be enabled without any dispatch routes and has bounded refresh settings", async () => {
  const config = await loadConfig({
    ...env,
    WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "capabilities-secret",
    WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "true",
  })
  expect(config.agentRuns).toBeUndefined()
  expect(config.executionCapabilities).toMatchObject({
    token: "capabilities-secret",
    refreshMs: 30_000,
    timeoutMs: 10_000,
    codexEnabled: true,
  })
  expect(
    localDiscoverySources(config, Effect.fail(new Error("unused"))).map((source) => source.kind),
  ).toEqual(["opencode", "codex"])
  await expect(
    loadConfig({
      ...env,
      WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "capabilities-secret",
      WORKFLOWD_EXECUTION_CAPABILITIES_TIMEOUT_MS: "60000",
    }),
  ).rejects.toThrow("TIMEOUT_MS")
  await expect(
    loadConfig({
      ...env,
      WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "capabilities-secret",
      WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "maybe",
    }),
  ).rejects.toThrow("CODEX_ENABLED")
})

test("capability authentication defaults to the existing agent-run token and supports a dedicated credential file", async () => {
  const config = await loadConfig({
    ...env,
    WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
    WORKFLOWD_AGENT_RUN_ROUTES: "legacy=fixture/fixture",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: "fixture=/fixture",
    WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS: "box",
  })
  expect(config.executionCapabilities?.token).toBe("agent-run-secret")
  expect(config.executionCapabilities?.codexEnabled).toBe(true)
  const claude = localDiscoverySources(config, Effect.fail(new Error("unused"))).find(
    (source) => source.kind === "claude",
  )
  expect(claude?.protocol).toBe("claude-agent-sdk/supportedModels")
  const dedicated = await loadConfig(
    { ...env, WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN_FILE: "/fixture/token" },
    { readFile: async () => "dedicated-secret\n" },
  )
  expect(dedicated.executionCapabilities?.token).toBe("dedicated-secret")
  expect(dedicated.executionCapabilities?.codexEnabled).toBe(false)
  expect(
    localDiscoverySources(dedicated, Effect.fail(new Error("unused"))).map((source) => source.kind),
  ).toEqual(["opencode"])
  expect(
    await loadExecutionCapabilitiesDaemon({
      WORKFLOWD_DAEMON_URL: "http://daemon",
      WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "dedicated-secret",
      WORKFLOWD_AGENT_RUN_TOKEN: "legacy-secret",
    }),
  ).toEqual({ baseUrl: "http://daemon", token: "dedicated-secret" })
  expect(
    await loadExecutionCapabilitiesDaemon({
      WORKFLOWD_DAEMON_URL: "http://daemon",
      WORKFLOWD_AGENT_RUN_TOKEN: "legacy-secret",
    }),
  ).toEqual({ baseUrl: "http://daemon", token: "legacy-secret" })
})

test("typed selection policy loads from a file and rejects invalid intent targets", async () => {
  const base = {
    WORKFLOWD_MODE: "execution",
    WORKFLOWD_AGENT_RUN_TOKEN: "fixture-secret",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: "fixture=/fixture",
    WORKFLOWD_EXECUTION_POLICY_FILE: "/fixture/policy",
  }
  const policy = {
    revision: "v1",
    allowUnknownAccess: true,
    intents: [{ name: "research", family: "sol" }],
  }
  const config = await loadConfig(base, { readFile: async () => JSON.stringify(policy) })
  expect(config.executionPolicy).toEqual(policy)
  await expect(
    loadConfig(base, {
      readFile: async () => JSON.stringify({ ...policy, intents: [{ name: "research" }] }),
    }),
  ).rejects.toThrow()
})

test("explicitly disabling Claude discovery overrides legacy Claude routes and hosts", async () => {
  const config = await loadConfig({
    ...env,
    WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
    WORKFLOWD_AGENT_RUN_ROUTES: "legacy=fixture/fixture",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: "fixture=/fixture",
    WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS: "box",
    WORKFLOWD_EXECUTION_CAPABILITIES_CLAUDE_ENABLED: "false",
  })
  expect(localDiscoverySources(config).map((source) => source.kind)).toEqual(["codex"])
})

test("custom family policy rejects overlapping model mappings instead of depending on file order", async () => {
  await expect(
    loadConfig(
      { WORKFLOWD_MODE: "execution", WORKFLOWD_EXECUTION_POLICY_FILE: "/fixture/policy" },
      {
        readFile: async () =>
          JSON.stringify({
            revision: "overlap",
            families: [
              { name: "a", harness: "codex", models: [{ model: "custom", version: "1" }] },
              {
                name: "b",
                harness: "codex",
                models: [{ model: "custom", provider: "openai", version: "2" }],
              },
            ],
          }),
      },
    ),
  ).rejects.toThrow("overlap")
})

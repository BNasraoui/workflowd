import { agentGitTestEnvironment } from "../helpers/agent-git-config"
import { expect, test } from "bun:test"
import { loadConfig } from "../../src/config"
import { Effect } from "effect"
import { localDiscoverySources } from "../../src/execution/local"
import { loadExecutionCapabilitiesDaemon } from "../../src/mcp/auth"
import { makeExecutionCapabilities } from "../../src/execution-capabilities"
import { resolveExecutionSelection } from "../../src/execution-selection"

const env = {
  ...agentGitTestEnvironment,
  GITHUB_APP_ID: "123",
  WORKFLOWD_AGENT_GIT_NAME: "Agent",
  WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
  WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
  WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
  GITHUB_PRIVATE_KEY_PATH: "/fixture/key",
  GITHUB_WEBHOOK_SECRET: "secret",
  OPENCODE_SERVER_PASSWORD: "secret",
  WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
  WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
  WORKFLOWD_HOST_ID: "box",
}

for (const kind of ["claude", "codex", "opencode"] as const)
  test(`configured ${kind} Actions-native discovery uses gateway custody and reports access as unknown`, async () => {
    const model = kind === "claude" ? "claude-opus-4-6" : "gpt-5.5"
    const provider = kind === "claude" ? "anthropic" : "openai"
    const config = await loadConfig({
      ...env,
      WORKFLOWD_AGENT_RUN_TOKEN: "fixture-token",
      WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES: "native=claude-opus-4-6,other=claude-opus-4-6",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "fixture=/fixture",
      WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES: JSON.stringify([
        {
          alias: "fixture",
          repository: "fixture/repo",
          repositoryId: 12,
          installationId: 1,
          workflowSha: "a".repeat(40),
          appActorId: 56,
          agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "b".repeat(64),
          tailscaleClientId: "fixture",
          tailscaleAudience: "fixture",
          privateBootstrap: { mode: "actions-native", repositoryOwnerId: 1 },
        },
      ]),
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
        nodeBinary: "/fixture/node",
        noscope: { binary: "/fixture/noscope", configHome: "/fixture/providers" },
        providerId: provider,
        ...(kind === "claude"
          ? {}
          : {
              native: {
                protocol: kind === "codex" ? "codex-chatgpt" : "openai-chat",
                models: [{ id: model, efforts: ["high"] }],
              },
            }),
        credentialRole: "private-role",
        maxStreams: 4,
        maxStreamsPerRun: 4,
      }),
    })
    const source = localDiscoverySources({
      ...config,
      credentialSocket: "/fixture/absent-local-credentials",
    }).filter((source) => source.executor === `${kind}:actions`)
    expect(source).toHaveLength(1)
    const catalog = makeExecutionCapabilities({
      host: "mint",
      sources: source,
      refreshMs: 1000,
      timeoutMs: 1000,
    })
    try {
      const snapshot = await catalog.list()
      expect(snapshot.capabilities).toHaveLength(1)
      expect(snapshot.capabilities[0]).toMatchObject({
        identity: {
          host: "github-actions",
          executor: `${kind}:actions`,
          provider,
          model,
        },
        thinking: { status: kind === "claude" ? "unknown" : "configured" },
        availability: "unknown",
      })
      expect(JSON.stringify(snapshot)).not.toContain("private-role")
      const requested = {
        model,
        executor: `${kind}:actions`,
        provider,
      }
      expect(resolveExecutionSelection(snapshot, requested)).toEqual({
        outcome: "refused",
        reason: "model_access_unknown",
      })
      expect(
        resolveExecutionSelection(snapshot, { ...requested, allowUnknownAccess: true }),
      ).toMatchObject({
        outcome: "resolved",
        selection: { host: "github-actions", executor: `${kind}:actions`, evidence: "configured" },
      })
      expect(
        resolveExecutionSelection(snapshot, {
          ...requested,
          allowUnknownAccess: true,
          thinking: { effort: "max" },
        }),
      ).toEqual({ outcome: "refused", reason: "unsupported_thinking" })
      if (kind !== "claude")
        expect(
          resolveExecutionSelection(snapshot, {
            ...requested,
            allowUnknownAccess: true,
            thinking: { effort: "high" },
          }),
        ).toMatchObject({ outcome: "resolved", selection: { thinking: { effort: "high" } } })
      expect(
        localDiscoverySources({
          ...config,
          agentRuns: { ...config.agentRuns!, sandboxRepositories: [] },
        }).some((source) => source.executor === `${kind}:actions`),
      ).toBe(false)
    } finally {
      await catalog.close()
    }
  })

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
  expect(await claude?.discover(new AbortController().signal)).toEqual({ status: "unsupported" })
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

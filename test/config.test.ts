import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config"

import { requiredEnvironment } from "./helpers/config"
describe("loadConfig", () => {
  test("execution-only mode needs no OpenCode or GitHub credentials and no aliases", async () => {
    const config = await loadConfig({
      WORKFLOWD_MODE: "execution",
      WORKFLOWD_AGENT_RUN_TOKEN: "execution-secret",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/tmp/repository",
      WORKFLOWD_AGENT_GIT_NAME: "Agent",
      WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
    })
    expect(config.mode).toBe("execution")
    expect(config.agentRuns?.routes).toEqual([])
    expect(config.executionCapabilities?.codexEnabled).toBe(true)
    expect(config.github).toBeUndefined()
    expect(config.openCode).toBeUndefined()
  })
  test("execution dispatch requires a complete agent git identity", async () => {
    for (const identity of [
      {},
      { WORKFLOWD_AGENT_GIT_NAME: "Agent" },
      { WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test" },
    ]) {
      await expect(
        loadConfig({
          WORKFLOWD_MODE: "execution",
          WORKFLOWD_AGENT_RUN_TOKEN: "execution-secret",
          WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/tmp/repository",
          ...identity,
        }),
      ).rejects.toThrow("WORKFLOWD_AGENT_GIT")
    }
  })
  test("loads Claude CLI-only dispatch routes and validates their syntax", async () => {
    const base = {
      ...requiredEnvironment,
      WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/home/test/repos/workflowd",
    }
    const config = await loadConfig({
      ...base,
      WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES: "claude=claude-opus-5-5,sonnet=claude-sonnet-5-5",
    })
    expect(config.agentRuns?.routes).toEqual([])
    expect(config.agentRuns?.claudeRoutes).toEqual([
      { name: "claude", modelID: "claude-opus-5-5" },
      { name: "sonnet", modelID: "claude-sonnet-5-5" },
    ])
    await expect(
      loadConfig({
        ...base,
        WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES: "claude=anthropic/claude-opus-5-5",
      }),
    ).rejects.toThrow("claude model id")
    await expect(
      loadConfig({ ...requiredEnvironment, WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES: "claude=opus" }),
    ).rejects.toThrow("WORKFLOWD_AGENT_RUN_TOKEN is required")
  })
  test("loads the optional agent-run section with routes and repositories", async () => {
    const config = await loadConfig(
      {
        ...requiredEnvironment,
        WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
        WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
        WORKFLOWD_AGENT_RUN_CODEX_ROUTES: "scan=gpt-5.1-codex,quick=",
        WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/home/test/repos/workflowd",
        WORKFLOWD_AGENT_RUN_AGENT: "remote-worker",
      },
      { home: "/home/test" },
    )

    expect(config.agentRuns).toEqual({
      token: "agent-run-secret",
      claudeBinary: "claude",
      claudeHosts: [],
      claudeRoutes: [],
      codexBinary: "codex",
      remoteTurnTimeoutMs: 120_000,
      routes: [{ name: "implement", providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }],
      codexRoutes: [
        { name: "scan", modelID: "gpt-5.1-codex" },
        { name: "quick", modelID: null },
      ],
      repositories: [{ name: "workflowd", directory: "/home/test/repos/workflowd" }],
      agent: "remote-worker",
      verifyTimeoutMs: 120_000,
      verifyPollIntervalMs: 2_000,
      progressWindowMs: 20 * 60_000,
      maxAttempts: 3,
      worktreeRetentionMs: 2 * 24 * 60 * 60_000,
    })
  })

  test("configures agent-run worktree retention", async () => {
    const base = {
      ...requiredEnvironment,
      WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
      WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/home/test/repos/workflowd",
    }
    const config = await loadConfig({
      ...base,
      WORKFLOWD_AGENT_RUN_WORKTREE_RETENTION_MS: "3600000",
    })
    expect(config.agentRuns?.worktreeRetentionMs).toBe(3_600_000)
    await expect(
      loadConfig({ ...base, WORKFLOWD_AGENT_RUN_WORKTREE_RETENTION_MS: "0" }),
    ).rejects.toThrow("WORKFLOWD_AGENT_RUN_WORKTREE_RETENTION_MS must be a positive integer")
  })

  test("configures an isolated Codex unit namespace", async () => {
    const config = await loadConfig({
      ...requiredEnvironment,
      WORKFLOWD_AGENT_RUN_TOKEN: "scratch-token",
      WORKFLOWD_AGENT_RUN_ROUTES: "other=fixture/fixture",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "scratch=/tmp/scratch",
      WORKFLOWD_AGENT_RUN_CODEX_UNIT_PREFIX: "workflowd-evidence59-test-",
    })
    expect(config.agentRuns?.codexUnitPrefix).toBe("workflowd-evidence59-test-")
  })

  test("parses the claude host allow-list and rejects malformed hosts and timeouts", async () => {
    const base = {
      ...requiredEnvironment,
      WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
      WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/home/test/repos/workflowd",
    }
    const config = await loadConfig(
      { ...base, WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS: "ben-arch, gpu-box" },
      { home: "/home/test" },
    )
    expect(config.agentRuns?.claudeHosts).toEqual(["ben-arch", "gpu-box"])
    await expect(
      loadConfig(
        { ...base, WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS: "ben-arch,bad host" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("invalid host id")
    await expect(
      loadConfig(
        { ...base, WORKFLOWD_AGENT_RUN_CLAUDE_HOSTS: "ben-arch,ben-arch" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("unique")
    await expect(
      loadConfig(
        { ...base, WORKFLOWD_AGENT_RUN_REMOTE_TURN_TIMEOUT_MS: "5000" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("between 10000 and 600000")
  })

  test("agent runs stay disabled without a token, and settings without one are an error", async () => {
    const disabled = await loadConfig(requiredEnvironment, { home: "/home/test" })
    expect(disabled.agentRuns).toBeUndefined()
    await expect(
      loadConfig(
        {
          ...requiredEnvironment,
          WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
        },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_AGENT_RUN_TOKEN is required")
    await expect(
      loadConfig(
        {
          ...requiredEnvironment,
          WORKFLOWD_AGENT_RUN_CODEX_ROUTES: "scan=gpt-5.1-codex",
        },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_AGENT_RUN_TOKEN is required")
    await expect(
      loadConfig(
        { ...requiredEnvironment, WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_AGENT_RUN_REPOSITORIES")
  })

  test("loads an optional central remote coordinator with token-file credentials", async () => {
    const config = await loadConfig(
      {
        ...requiredEnvironment,
        WORKFLOWD_REMOTE_COORDINATOR_ENABLED: "true",
        WORKFLOWD_NATS_SERVERS: "tls://nats.example.ts.net:4222,nats://127.0.0.1:4222",
        WORKFLOWD_NATS_TOKEN_FILE: "/run/credentials/nats-token",
      },
      {
        home: "/home/test",
        readFile: async (path) =>
          path === "/run/credentials/nats-token" ? "remote-token\n" : "unexpected",
      },
    )

    expect(config.remoteCoordinator).toEqual({
      servers: ["tls://nats.example.ts.net:4222", "nats://127.0.0.1:4222"],
      auth: { mode: "token", token: "remote-token" },
      workerId: "mint:remote-coordinator",
      leaseDurationMs: 60_000,
      commandTtlMs: 300_000,
      claudeCommandTtlMs: 600_000,
    })
  })

  test("groups validated settings by their runtime domain", async () => {
    const config = await loadConfig(
      {
        ...requiredEnvironment,
        WORKFLOWD_PUBLICATION_TIMEOUT_MS: "45000",
      },
      { home: "/home/test" },
    )

    expect(config).toEqual({
      agentGit: {
        name: "Agent",
        email: "agent@example.test",
        blockedEmails: ["blocked@example.test"],
      },
      http: {
        host: "127.0.0.1",
        port: 8787,
        maxWebhookBytes: 1_048_576,
      },
      github: {
        prRepositories: [{ repository: "example-owner/example", installationId: 91 }],
        appId: 123,
        allowedInstallationAccountIds: [81005232, 319835875],
        privateKeyPath: "/run/credentials/github-key.pem",
        webhookSecret: "webhook-secret",
      },
      storage: {
        databasePath: "/home/test/.local/state/workflowd/workflowd.db",
      },
      fixWork: {
        enabled: false,
      },
      workspace: {
        repositoryRoot: "/home/test/.local/share/workflowd/repositories",
        worktreeRoot: "/home/test/.local/share/workflowd/worktrees",
        worktreeRegistry: "/home/test/.local/share/opencode/worktree-jobs",
        localRepositories: ["/home/test/Documents/repos"],
        maxDiffBytes: 2_000_000,
      },
      openCode: {
        baseUrl: "http://127.0.0.1:4096",
        reviewUrl: "http://127.0.0.1:4098",
        attachUrl: "https://mint.example-tailnet.ts.net:4096",
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        username: "opencode",
        password: "server-password",
        reviewPassword: "review-password",
        model: "openai/gpt-5.6-sol",
        reviewerAgent: "pr-reviewer",
        fixerAgent: "pr-fixer",
        agentWakeAgent: "build",
        pollIntervalMs: 1_000,
      },
      worker: {
        hostId: "mint",
        concurrency: 2,
        pollIntervalMs: 1_000,
        jobTimeoutMs: 30 * 60_000,
        jobLeaseDurationMs: 31 * 60_000,
        publicationTimeoutMs: 45_000,
        publicationLeaseDurationMs: 105_000,
        agentBranchPrefixes: ["opencode/", "plan/"],
        trustedAgentUsers: [],
        commandUsers: [],
      },
    })
  })

  test("configures a credential-free private URL for resumable session commands", async () => {
    const config = await loadConfig(
      {
        ...requiredEnvironment,
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096/",
      },
      { home: "/home/test" },
    )

    expect(config.openCode?.attachUrl).toBe("https://mint.example-tailnet.ts.net:4096")
    await expect(
      loadConfig(
        {
          ...requiredEnvironment,
          WORKFLOWD_OPENCODE_ATTACH_URL: "https://user:secret@mint.example-tailnet.ts.net:4096",
        },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_OPENCODE_ATTACH_URL must not include credentials")
    for (const attachUrl of [
      "https://mint.example-tailnet.ts.net:4096/?access_token=secret",
      "https://mint.example-tailnet.ts.net:4096/#access_token=secret",
    ]) {
      await expect(
        loadConfig(
          {
            ...requiredEnvironment,
            WORKFLOWD_OPENCODE_ATTACH_URL: attachUrl,
          },
          { home: "/home/test" },
        ),
      ).rejects.toThrow("WORKFLOWD_OPENCODE_ATTACH_URL must not include credentials")
    }
    const withoutAttachUrl = { ...requiredEnvironment }
    delete withoutAttachUrl.WORKFLOWD_OPENCODE_ATTACH_URL
    await expect(loadConfig(withoutAttachUrl, { home: "/home/test" })).rejects.toThrow(
      "Missing required environment variable WORKFLOWD_OPENCODE_ATTACH_URL",
    )
  })

  test("requires explicit opt-in before enabling Fix Work", async () => {
    const disabled = await loadConfig(requiredEnvironment, {
      home: "/home/test",
    })
    const enabled = await loadConfig(
      {
        ...requiredEnvironment,
        WORKFLOWD_FIX_WORK_ENABLED: "true",
        WORKFLOWD_GIT_SIGNING_KEY: "a".repeat(40),
        WORKFLOWD_TRUSTED_AGENT_USERS: "Trusted-Agent[bot]",
      },
      { home: "/home/test" },
    )

    expect(disabled.fixWork.enabled).toBe(false)
    expect(enabled.fixWork.enabled).toBe(true)
    expect(enabled.worker.trustedAgentUsers).toEqual(["trusted-agent[bot]"])
    expect(enabled.workspace.gitSigningKey).toBe("a".repeat(40))
    await expect(
      loadConfig(
        { ...requiredEnvironment, WORKFLOWD_FIX_WORK_ENABLED: "true" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_GIT_SIGNING_KEY is required when Fix Work is enabled")
    await expect(
      loadConfig(
        {
          ...requiredEnvironment,
          WORKFLOWD_FIX_WORK_ENABLED: "true",
          WORKFLOWD_GIT_SIGNING_KEY: "a".repeat(40),
        },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_TRUSTED_AGENT_USERS is required when Fix Work is enabled")
    await expect(
      loadConfig(
        { ...requiredEnvironment, WORKFLOWD_FIX_WORK_ENABLED: "yes" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_FIX_WORK_ENABLED must be true or false")
  })
})

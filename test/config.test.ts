import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config"

const requiredEnvironment: Record<string, string | undefined> = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY_PATH: "/run/credentials/github-key.pem",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  OPENCODE_SERVER_PASSWORD: "server-password",
}

describe("loadConfig", () => {
  test("groups validated settings by their runtime domain", async () => {
    const config = await loadConfig(
      {
        ...requiredEnvironment,
        WORKFLOWD_PUBLICATION_TIMEOUT_MS: "45000",
      },
      { home: "/home/test" },
    )

    expect(config).toEqual({
      http: {
        host: "127.0.0.1",
        port: 8787,
        maxWebhookBytes: 1_048_576,
      },
      github: {
        appId: 123,
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
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        username: "opencode",
        password: "server-password",
        model: "openai/gpt-5.6-sol",
        reviewerAgent: "pr-reviewer",
        fixerAgent: "pr-fixer",
        pollIntervalMs: 1_000,
      },
      worker: {
        concurrency: 2,
        pollIntervalMs: 1_000,
        jobTimeoutMs: 30 * 60_000,
        jobLeaseDurationMs: 31 * 60_000,
        publicationTimeoutMs: 45_000,
        publicationLeaseDurationMs: 105_000,
        agentBranchPrefixes: ["opencode/", "plan/"],
        commandUsers: [],
      },
    })
  })

  test("requires explicit opt-in before enabling Fix Work", async () => {
    const disabled = await loadConfig(requiredEnvironment, {
      home: "/home/test",
    })
    const enabled = await loadConfig(
      { ...requiredEnvironment, WORKFLOWD_FIX_WORK_ENABLED: "true" },
      { home: "/home/test" },
    )

    expect(disabled.fixWork.enabled).toBe(false)
    expect(enabled.fixWork.enabled).toBe(true)
    await expect(
      loadConfig(
        { ...requiredEnvironment, WORKFLOWD_FIX_WORK_ENABLED: "yes" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_FIX_WORK_ENABLED must be true or false")
  })

  test("loads secrets from files and removes one trailing line ending", async () => {
    const reads: Array<string> = []
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/run/credentials/github-key.pem",
        GITHUB_WEBHOOK_SECRET_FILE: "/run/credentials/webhook-secret",
        OPENCODE_SERVER_PASSWORD_FILE: "/run/credentials/opencode-password",
      },
      {
        home: "/home/test",
        readFile: async (path) => {
          reads.push(path)
          return path.endsWith("webhook-secret") ? "webhook-from-file\n" : "password-from-file\r\n"
        },
      },
    )

    expect(reads).toEqual(["/run/credentials/webhook-secret", "/run/credentials/opencode-password"])
    expect(config.github.webhookSecret).toBe("webhook-from-file")
    expect(config.openCode.password).toBe("password-from-file")
  })

  test.each([
    [
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_WEBHOOK_SECRET_FILE",
      "GITHUB_WEBHOOK_SECRET and GITHUB_WEBHOOK_SECRET_FILE cannot both be set",
    ],
    [
      "OPENCODE_SERVER_PASSWORD",
      "OPENCODE_SERVER_PASSWORD_FILE",
      "OPENCODE_SERVER_PASSWORD and OPENCODE_SERVER_PASSWORD_FILE cannot both be set",
    ],
  ])("rejects conflicting %s sources", async (direct, file, message) => {
    await expect(
      loadConfig(
        { ...requiredEnvironment, [direct]: "direct", [file]: "/secret" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow(message)
  })

  test.each([
    ["GITHUB_WEBHOOK_SECRET", "GITHUB_WEBHOOK_SECRET_FILE"],
    ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_PASSWORD_FILE"],
  ])("requires either %s or %s", async (direct, file) => {
    const environment = { ...requiredEnvironment }
    delete environment[direct]

    await expect(loadConfig(environment, { home: "/home/test" })).rejects.toThrow(
      `Set exactly one of ${direct} or ${file}`,
    )
  })

  test("reports unreadable and empty secret files without exposing content", async () => {
    const environment = {
      ...requiredEnvironment,
      GITHUB_WEBHOOK_SECRET: undefined,
      GITHUB_WEBHOOK_SECRET_FILE: "/missing/webhook-secret",
    }

    await expect(
      loadConfig(environment, {
        home: "/home/test",
        readFile: async () => {
          throw new Error("permission denied")
        },
      }),
    ).rejects.toThrow("Could not read GITHUB_WEBHOOK_SECRET_FILE at /missing/webhook-secret")

    await expect(
      loadConfig(environment, {
        home: "/home/test",
        readFile: async () => "\n",
      }),
    ).rejects.toThrow("GITHUB_WEBHOOK_SECRET_FILE must not be empty")
  })

  test.each([
    ["WORKFLOWD_PORT", "0", "WORKFLOWD_PORT must be between 1 and 65535"],
    ["WORKFLOWD_PORT", "65536", "WORKFLOWD_PORT must be between 1 and 65535"],
    ["OPENCODE_SERVER_URL", "localhost:4096", "OPENCODE_SERVER_URL must be an HTTP(S) URL"],
    ["OPENCODE_SERVER_URL", "ftp://localhost", "OPENCODE_SERVER_URL must be an HTTP(S) URL"],
    ["WORKFLOWD_MODEL", "claude", "WORKFLOWD_MODEL must use provider/model syntax"],
    ["WORKFLOWD_MODEL", "anthropic/", "WORKFLOWD_MODEL must use provider/model syntax"],
    ["WORKFLOWD_MODEL", "anthropic//claude", "WORKFLOWD_MODEL must use provider/model syntax"],
    [
      "WORKFLOWD_REVIEWER_AGENT",
      "review agent",
      "WORKFLOWD_REVIEWER_AGENT must be a valid agent ID",
    ],
    [
      "WORKFLOWD_AGENT_BRANCH_PREFIXES",
      "",
      "WORKFLOWD_AGENT_BRANCH_PREFIXES must contain non-empty prefixes",
    ],
    [
      "WORKFLOWD_AGENT_BRANCH_PREFIXES",
      "opencode/,,plan/",
      "WORKFLOWD_AGENT_BRANCH_PREFIXES must contain non-empty prefixes",
    ],
    [
      "WORKFLOWD_COMMAND_USERS",
      "valid-user,not_a_user",
      "WORKFLOWD_COMMAND_USERS must contain valid GitHub users",
    ],
    [
      "WORKFLOWD_COMMAND_USERS",
      "not--a-user",
      "WORKFLOWD_COMMAND_USERS must contain valid GitHub users",
    ],
  ])("rejects invalid %s", async (name, value, message) => {
    await expect(
      loadConfig({ ...requiredEnvironment, [name]: value }, { home: "/home/test" }),
    ).rejects.toThrow(message)
  })

  test.each([
    [
      "WORKFLOWD_JOB_LEASE_MS",
      "1800000",
      "WORKFLOWD_JOB_LEASE_MS must be greater than WORKFLOWD_JOB_TIMEOUT_MS",
    ],
    [
      "WORKFLOWD_PUBLICATION_LEASE_MS",
      "60000",
      "WORKFLOWD_PUBLICATION_LEASE_MS must be greater than WORKFLOWD_PUBLICATION_TIMEOUT_MS",
    ],
  ])("requires a safe %s relationship", async (name, value, message) => {
    await expect(
      loadConfig({ ...requiredEnvironment, [name]: value }, { home: "/home/test" }),
    ).rejects.toThrow(message)
  })
})

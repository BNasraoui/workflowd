import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config"
import { configuredWebhookInstallations } from "../src/webhook-installations"
import { agentGitTestEnvironment } from "./helpers/agent-git-config"

import { qrspiDefinition, requiredEnvironment } from "./helpers/config"
describe("loadConfig integrations", () => {
  test("enables trusted QRSPI ingress only with a complete repository and Beads binding", async () => {
    const config = await loadConfig(
      {
        ...requiredEnvironment,
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: "/srv/example",
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
      },
      { home: "/home/test" },
    )

    expect(config.qrspi).toEqual({
      token: "kickoff-secret",
      installationId: 91,
      repository: {
        providerInstanceId: "github-app-123",
        repositoryId: "42",
        repositoryFullName: "example-owner/example",
      },
      trackerInstanceId: "workspace-42",
      beadsWorkspace: "/srv/example",
      baseRef: "main",
      repositoryOperationTimeoutMs: 30_000,
      operationCompletionMarginMs: 10_000,
      leaseDurationMs: 60_000,
      workflowDefinition: qrspiDefinition,
    })
  })

  test("optionally loads the test-job token from exactly one direct or file source", async () => {
    const disabled = await loadConfig(requiredEnvironment, { home: "/home/test" })
    const direct = await loadConfig(
      { ...requiredEnvironment, WORKFLOWD_TEST_JOB_TOKEN: "test-job-secret" },
      { home: "/home/test" },
    )
    const fromFile = await loadConfig(
      { ...requiredEnvironment, WORKFLOWD_TEST_JOB_TOKEN_FILE: "/run/test-job-token" },
      { home: "/home/test", readFile: async () => "file-test-job-secret\n" },
    )

    expect(disabled.testJobCanary).toBeUndefined()
    expect(direct.testJobCanary).toEqual({ token: "test-job-secret" })
    expect(fromFile.testJobCanary).toEqual({ token: "file-test-job-secret" })
    await expect(
      loadConfig(
        {
          ...requiredEnvironment,
          WORKFLOWD_TEST_JOB_TOKEN: "test-job-secret",
          WORKFLOWD_TEST_JOB_TOKEN_FILE: "/run/test-job-token",
        },
        { home: "/home/test" },
      ),
    ).rejects.toThrow(
      "WORKFLOWD_TEST_JOB_TOKEN and WORKFLOWD_TEST_JOB_TOKEN_FILE cannot both be set",
    )
  })

  test("requires a sensible test-job token length", async () => {
    await expect(
      loadConfig(
        { ...requiredEnvironment, WORKFLOWD_TEST_JOB_TOKEN: "short" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_TEST_JOB_TOKEN must contain at least 8 characters")
  })

  test("optionally loads the dogfood token from exactly one direct or file source", async () => {
    const disabled = await loadConfig(requiredEnvironment, { home: "/home/test" })
    const direct = await loadConfig(
      { ...requiredEnvironment, WORKFLOWD_DOGFOOD_TOKEN: "dogfood-secret" },
      { home: "/home/test" },
    )
    const fromFile = await loadConfig(
      { ...requiredEnvironment, WORKFLOWD_DOGFOOD_TOKEN_FILE: "/run/dogfood-token" },
      { home: "/home/test", readFile: async () => "file-dogfood-secret\n" },
    )

    expect(disabled.dogfood).toBeUndefined()
    expect(direct.dogfood).toEqual({ token: "dogfood-secret" })
    expect(fromFile.dogfood).toEqual({ token: "file-dogfood-secret" })
    await expect(
      loadConfig(
        {
          ...requiredEnvironment,
          WORKFLOWD_DOGFOOD_TOKEN: "dogfood-secret",
          WORKFLOWD_DOGFOOD_TOKEN_FILE: "/run/dogfood-token",
        },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_DOGFOOD_TOKEN and WORKFLOWD_DOGFOOD_TOKEN_FILE cannot both be set")
  })

  test("requires a sensible dogfood token length", async () => {
    await expect(
      loadConfig(
        { ...requiredEnvironment, WORKFLOWD_DOGFOOD_TOKEN: "short" },
        { home: "/home/test" },
      ),
    ).rejects.toThrow("WORKFLOWD_DOGFOOD_TOKEN must contain at least 8 characters")
  })

  test.each(["WORKFLOWD_QRSPI_PROVIDER_INSTANCE_ID", "WORKFLOWD_QRSPI_BASE_REF"])(
    "requires the QRSPI token when %s is present",
    async (name) => {
      await expect(
        loadConfig({ ...requiredEnvironment, [name]: "configured" }, { home: "/home/test" }),
      ).rejects.toThrow("WORKFLOWD_QRSPI_TOKEN is required when QRSPI settings are present")
    },
  )

  test("requires the WorkflowStart lease to exceed repository timeout plus completion margin", async () => {
    await expect(
      loadConfig(
        {
          ...requiredEnvironment,
          WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
          WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
          WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
          WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
          WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
          WORKFLOWD_QRSPI_BEADS_WORKSPACE: "/srv/example",
          WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
          WORKFLOWD_QRSPI_REPOSITORY_TIMEOUT_MS: "100",
          WORKFLOWD_QRSPI_COMPLETION_MARGIN_MS: "50",
          WORKFLOWD_QRSPI_LEASE_MS: "150",
        },
        { home: "/home/test" },
      ),
    ).rejects.toThrow(
      "WORKFLOWD_QRSPI_LEASE_MS must be greater than repository timeout plus completion margin",
    )
  })

  test("loads secrets from files and removes one trailing line ending", async () => {
    const reads: Array<string> = []
    const config = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_AGENT_GIT_NAME: "Agent",
        WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/run/credentials/github-key.pem",
        GITHUB_WEBHOOK_SECRET_FILE: "/run/credentials/webhook-secret",
        OPENCODE_SERVER_PASSWORD_FILE: "/run/credentials/opencode-password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD_FILE: "/run/credentials/reviewer-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
      },
      {
        home: "/home/test",
        readFile: async (path) => {
          reads.push(path)
          if (path.endsWith("reviewer-password")) return "review-password\n"
          return path.endsWith("webhook-secret") ? "webhook-from-file\n" : "password-from-file\r\n"
        },
      },
    )

    expect(reads).toEqual([
      "/run/credentials/webhook-secret",
      "/run/credentials/opencode-password",
      "/run/credentials/reviewer-password",
    ])
    expect(config.openCode?.reviewPassword).toBe("review-password")
    expect(config.github?.webhookSecret).toBe("webhook-from-file")
    expect(config.openCode?.password).toBe("password-from-file")
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
    [
      "WORKFLOWD_REVIEW_OPENCODE_PASSWORD",
      "WORKFLOWD_REVIEW_OPENCODE_PASSWORD_FILE",
      "WORKFLOWD_REVIEW_OPENCODE_PASSWORD and WORKFLOWD_REVIEW_OPENCODE_PASSWORD_FILE cannot both be set",
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
    ["WORKFLOWD_REVIEW_OPENCODE_PASSWORD", "WORKFLOWD_REVIEW_OPENCODE_PASSWORD_FILE"],
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

test("uses only PR and CI installations for webhook ingestion", async () => {
  const config = await loadConfig(
    {
      ...requiredEnvironment,
      WORKFLOWD_CI_ENABLED: "true",
      WORKFLOWD_CI_TOKEN: "test-ci-token",
      WORKFLOWD_CI_REPOSITORIES: JSON.stringify([
        { repository: "ci/repo", installationId: 92, workflows: ["CI"] },
      ]),
      WORKFLOWD_NATS_SERVERS: "nats://127.0.0.1:4222",
      WORKFLOWD_NATS_TOKEN: "test-token",
      WORKFLOWD_CODEX_RESIDENT_ENABLED: "true",
      WORKFLOWD_CODEX_RESIDENT_HOME: "/tmp/resident-home",
      WORKFLOWD_CODEX_RESIDENT_SOCKET: "/tmp/resident.sock",
      WORKFLOWD_WORKER_GITHUB_ENABLED: "true",
      WORKFLOWD_WORKER_GITHUB_DIRECTORY: "/tmp/worker-identities",
      WORKFLOWD_WORKER_GITHUB_SOCKET: "/tmp/worker.sock",
      WORKFLOWD_WORKER_GITHUB_REPOSITORIES: JSON.stringify([
        {
          name: "worker",
          repository: "worker/repo",
          installationId: 93,
          permissions: { contents: "read" },
        },
      ]),
      WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
      WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "sandbox=/tmp/sandbox",
      WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES: JSON.stringify([
        {
          alias: "sandbox",
          repository: "sandbox/repo",
          repositoryId: 42,
          installationId: 94,
          workflowSha: "a".repeat(40),
          appActorId: 10,
          agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "f".repeat(64),
          tailscaleClientId: "fixture",
          tailscaleAudience: "fixture",
        },
      ]),
      WORKFLOWD_QRSPI_TOKEN: "qrspi-secret",
      WORKFLOWD_QRSPI_INSTALLATION_ID: "95",
      WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
      WORKFLOWD_QRSPI_REPOSITORY: "qrspi/repo",
      WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
      WORKFLOWD_QRSPI_BEADS_WORKSPACE: "/tmp/workspace",
      WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
    },
    { home: "/tmp" },
  )
  expect([...configuredWebhookInstallations(config)].sort()).toEqual([91, 92])
  expect(config.github?.prRepositories).toEqual([
    { repository: "example-owner/example", installationId: 91 },
  ])
  const execution = await loadConfig({ WORKFLOWD_MODE: "execution" }, { home: "/tmp" })
  expect([...configuredWebhookInstallations(execution)]).toEqual([])
})

test("reviewer password must differ from agent-run password", async () => {
  await expect(
    loadConfig({ ...requiredEnvironment, WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "server-password" }),
  ).rejects.toThrow("Reviewer and agent-run passwords must differ")
})

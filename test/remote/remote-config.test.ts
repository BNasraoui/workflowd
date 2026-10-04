import { expect, test } from "bun:test"
import { loadRemoteProcessConfig } from "../../src/remote/config"

test("runner OpenCode credential files stay host-local and unsafe execution roots/URLs fail configuration", async () => {
  const base = {
    WORKFLOWD_NATS_SERVERS: "nats://localhost:4222",
    WORKFLOWD_NATS_TOKEN: "fixture",
    WORKFLOWD_REMOTE_HOST_ID: "runner-b",
    WORKFLOWD_RUNNER_AGENT_REPOSITORIES: "repo=/srv/runner/repo",
  }
  const config = await loadRemoteProcessConfig(
    {
      ...base,
      WORKFLOWD_OPENCODE_PASSWORD_FILE: "/run/credentials/opencode",
      WORKFLOWD_RUNNER_OPENCODE_URL: "http://127.0.0.1:4096",
    },
    { readFile: async () => "host-local-secret\n" },
  )
  expect(config.agentExecution?.openCodePassword).toBe("host-local-secret")
  await expect(
    loadRemoteProcessConfig({ ...base, WORKFLOWD_RUNNER_AGENT_WORKTREE_ROOT: "relative" }),
  ).rejects.toThrow("absolute path")
  await expect(
    loadRemoteProcessConfig({
      ...base,
      WORKFLOWD_RUNNER_OPENCODE_URL: "http://user:secret@localhost:4096",
    }),
  ).rejects.toThrow("credential-free")
  await expect(
    loadRemoteProcessConfig({
      ...base,
      WORKFLOWD_OPENCODE_PASSWORD: "secret",
      WORKFLOWD_OPENCODE_PASSWORD_FILE: "/secret",
    }),
  ).rejects.toThrow("only one")
})

test("runner execution resolves repository and workspace policy locally without coordinator credentials", async () => {
  const config = await loadRemoteProcessConfig({
    WORKFLOWD_NATS_SERVERS: "nats://localhost:4222",
    WORKFLOWD_NATS_TOKEN: "fixture",
    WORKFLOWD_REMOTE_HOST_ID: "runner-b",
    WORKFLOWD_RUNNER_AGENT_REPOSITORIES: "repo=/srv/runner/repo",
    WORKFLOWD_RUNNER_AGENT_WORKTREE_ROOT: "/srv/runner/worktrees",
    WORKFLOWD_AGENT_RUN_CODEX_BIN: "/bin/codex",
    WORKFLOWD_RUNNER_OPENCODE_URL: "http://localhost:4096",
  })
  expect(config).toMatchObject({
    agentExecution: {
      repositories: [{ name: "repo", directory: "/srv/runner/repo" }],
      worktreeRoot: "/srv/runner/worktrees",
      codexBinary: "/bin/codex",
      openCodeUrl: "http://localhost:4096",
    },
  })
  await expect(
    loadRemoteProcessConfig({
      WORKFLOWD_NATS_SERVERS: "nats://localhost:4222",
      WORKFLOWD_NATS_TOKEN: "fixture",
      WORKFLOWD_REMOTE_HOST_ID: "runner-b",
      WORKFLOWD_RUNNER_AGENT_REPOSITORIES: "repo=relative",
    }),
  ).rejects.toThrow("absolute path")
})

test("runner config is explicit and reads its NATS token from a credential file", async () => {
  const config = await loadRemoteProcessConfig(
    {
      WORKFLOWD_NATS_SERVERS: "nats://control.example.ts.net:4222",
      WORKFLOWD_NATS_TOKEN_FILE: "/run/credentials/nats-token",
      WORKFLOWD_REMOTE_HOST_ID: "gpu-host",
      WORKFLOWD_REMOTE_DATABASE_PATH: "/var/lib/workflowd/runner.db",
    },
    { readFile: async () => "secret-token\n" },
  )

  expect(config).toEqual({
    servers: ["nats://control.example.ts.net:4222"],
    auth: { mode: "token", token: "secret-token" },
    hostId: "gpu-host",
    databasePath: "/var/lib/workflowd/runner.db",
    claudeDirectories: [],
    claudeBinary: "claude",
  })
})

test("runner config reads a per-identity NATS creds file", async () => {
  const creds =
    "-----BEGIN NATS USER JWT-----\njwt\n------END NATS USER JWT------\n\n" +
    "-----BEGIN USER NKEY SEED-----\nseed\n------END USER NKEY SEED------"
  const config = await loadRemoteProcessConfig(
    {
      WORKFLOWD_NATS_SERVERS: "nats://control.example.ts.net:4222",
      WORKFLOWD_NATS_CREDS_FILE: "/run/credentials/nats-creds",
      WORKFLOWD_REMOTE_HOST_ID: "gpu-host",
      WORKFLOWD_REMOTE_DATABASE_PATH: "/var/lib/workflowd/runner.db",
    },
    { readFile: async () => `${creds}\n` },
  )

  expect(config.auth).toEqual({ mode: "creds", creds })
})

test("runner config rejects simultaneous direct and file secrets", async () => {
  await expect(
    loadRemoteProcessConfig({
      WORKFLOWD_NATS_SERVERS: "nats://127.0.0.1:4222",
      WORKFLOWD_NATS_TOKEN: "direct",
      WORKFLOWD_NATS_TOKEN_FILE: "/token",
      WORKFLOWD_REMOTE_HOST_ID: "host-a",
    }),
  ).rejects.toThrow("Set exactly one of")
})

test("remote config accepts a TLS NATS endpoint", async () => {
  const config = await loadRemoteProcessConfig({
    WORKFLOWD_NATS_SERVERS: "tls://nats.example.ts.net:4222",
    WORKFLOWD_NATS_TOKEN: "secret-token",
    WORKFLOWD_REMOTE_HOST_ID: "host-a",
  })

  expect(config.servers).toEqual(["tls://nats.example.ts.net:4222"])
})

for (const server of [
  "nats://user:pass@nats.example:4222",
  "tls://nats.example:4222?token=secret",
  "nats://nats.example:4222#credential",
  "https://nats.example:4222",
]) {
  test(`remote config rejects unsafe NATS URL ${server}`, async () => {
    await expect(
      loadRemoteProcessConfig({
        WORKFLOWD_NATS_SERVERS: server,
        WORKFLOWD_NATS_TOKEN: "secret-token",
        WORKFLOWD_REMOTE_HOST_ID: "host-a",
      }),
    ).rejects.toThrow("NATS server URL")
  })
}

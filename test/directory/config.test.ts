import { expect, test } from "bun:test"
import { loadDirectoryRemoteConfig, loadDirectoryRunnerConfig } from "../../src/directory/config"

test("host credential enrollment cannot assign the same proof key to two host identities", async () => {
  await expect(
    loadDirectoryRemoteConfig(
      {
        WORKFLOWD_DIRECTORY_PEERS: JSON.stringify({ "host-b": "/b", "host-c": "/c" }),
        WORKFLOWD_NATS_SERVERS: "nats://127.0.0.1:4222",
        WORKFLOWD_NATS_TOKEN: "isolated",
      },
      "host-a",
      async () => "same-credential-".repeat(3),
    ),
  ).rejects.toThrow("distinct")
})
test("directory opt-in rejects incomplete identity and unsafe transport configuration without reading live credentials", async () => {
  expect(await loadDirectoryRunnerConfig({})).toBeUndefined()
  await expect(
    loadDirectoryRunnerConfig({ WORKFLOWD_DIRECTORY_CREDENTIAL_FILE: "/fixture" }),
  ).rejects.toThrow("coordinator")
  await expect(
    loadDirectoryRemoteConfig(
      { WORKFLOWD_DIRECTORY_PEERS: '{"host-a":"/fixture"}' },
      "host-a",
      async () => "never",
    ),
  ).rejects.toThrow("other hosts")
  await expect(
    loadDirectoryRemoteConfig(
      {
        WORKFLOWD_DIRECTORY_PEERS: '{"host-b":"/fixture"}',
        WORKFLOWD_DIRECTORY_REFRESH_MS: "1000",
        WORKFLOWD_DIRECTORY_LEASE_MS: "100",
      },
      "host-a",
      async () => "never",
    ),
  ).rejects.toThrow("interval")
  await expect(
    loadDirectoryRemoteConfig(
      {
        WORKFLOWD_DIRECTORY_PEERS: '{"host-b":"/fixture"}',
        WORKFLOWD_NATS_SERVERS: "nats://user:private@localhost:4222",
        WORKFLOWD_NATS_TOKEN: "isolated",
      },
      "host-a",
      async () => "credential-".repeat(5),
    ),
  ).rejects.toThrow()
  await expect(
    loadDirectoryRunnerConfig(
      {
        WORKFLOWD_DIRECTORY_CREDENTIAL_FILE: "/fixture",
        WORKFLOWD_DIRECTORY_COORDINATOR_HOST: "host-a",
        WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "maybe",
      },
      async () => "credential-".repeat(5),
    ),
  ).rejects.toThrow("Codex")
})

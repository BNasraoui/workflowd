import { expect, test } from "bun:test"
import { loadWorkerIdentityConfig } from "../../src/worker-identity/config"
const env = {
  WORKFLOWD_WORKER_GITHUB_ENABLED: "true",
  WORKFLOWD_WORKER_GITHUB_SOCKET: "/tmp/broker.sock",
  WORKFLOWD_WORKER_GITHUB_DIRECTORY: "/state/workers",
  WORKFLOWD_WORKER_GITHUB_REPOSITORIES: JSON.stringify([
    { name: "repo", repository: "o/r", installationId: 1, permissions: { actions: "read" } },
  ]),
}
test("identity is opt-in and validates its boundary without exposing secrets", async () => {
  expect(await loadWorkerIdentityConfig({})).toBeUndefined()
  expect((await loadWorkerIdentityConfig(env))?.policies[0]?.repository).toBe("o/r")
  for (const override of [
    { WORKFLOWD_WORKER_GITHUB_ENABLED: "yes" },
    { WORKFLOWD_WORKER_GITHUB_SOCKET: undefined },
    { WORKFLOWD_WORKER_GITHUB_DIRECTORY: "relative" },
    {
      WORKFLOWD_WORKER_GITHUB_REPOSITORIES: JSON.stringify([
        { name: "repo", repository: "o/r", installationId: 1, permissions: {} },
      ]),
    },
  ]) {
    expect(() => loadWorkerIdentityConfig({ ...env, ...override })).toThrow()
  }
})

test("agent-host broker configuration requires a distinct UID, shared group, own home and trusted command", () => {
  const hosted = {
    ...env,
    WORKFLOWD_AGENT_HOST_SOCKET: "/run/host.sock",
    WORKFLOWD_AGENT_HOME: "/var/lib/agent",
    WORKFLOWD_AGENT_UID: String(process.getuid!() + 10000),
    WORKFLOWD_AGENT_GID: "61000",
    WORKFLOWD_WORKER_GITHUB_COMMAND: "/usr/local/libexec/worker-github.js",
  }
  expect(loadWorkerIdentityConfig(hosted)).toMatchObject({
    home: hosted.WORKFLOWD_AGENT_HOME,
    command: hosted.WORKFLOWD_WORKER_GITHUB_COMMAND,
    peer: {
      controllerUid: process.getuid!(),
      agentUid: process.getuid!() + 10000,
      groupGid: 61000,
    },
  })
  for (const override of [
    { WORKFLOWD_AGENT_UID: "0" },
    { WORKFLOWD_AGENT_UID: String(process.getuid!()) },
    { WORKFLOWD_AGENT_GID: "-1" },
    { WORKFLOWD_AGENT_HOME: undefined },
    { WORKFLOWD_AGENT_HOME: "relative" },
    { WORKFLOWD_WORKER_GITHUB_COMMAND: undefined },
    { WORKFLOWD_WORKER_GITHUB_COMMAND: "relative" },
  ])
    expect(() => loadWorkerIdentityConfig({ ...hosted, ...override })).toThrow()
})

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
    await expect(loadWorkerIdentityConfig({ ...env, ...override })).rejects.toThrow()
  }
})

import { expect, test } from "bun:test"
import { loadCiConfig } from "../../src/ci/config"
test("CI defaults off and requires explicit repository workflows", async () => {
  expect(await loadCiConfig({}, async () => "")).toBeUndefined()
  await expect(loadCiConfig({ WORKFLOWD_CI_ENABLED: "true" }, async () => "")).rejects.toThrow()
  const config = await loadCiConfig(
    {
      WORKFLOWD_CI_ENABLED: "true",
      WORKFLOWD_CI_TOKEN: "ci-secret-test",
      WORKFLOWD_CI_REPOSITORIES: JSON.stringify([
        { repository: "owner/repo", installationId: 1, workflows: ["CI"] },
      ]),
      WORKFLOWD_NATS_TOKEN: "test-token",
      WORKFLOWD_NATS_SERVERS: "nats://127.0.0.1:4222",
    },
    async () => "",
  )
  expect(config?.repositories[0]?.workflows).toEqual(["CI"])
})

import { agentGitTestEnvironment } from "./helpers/agent-git-config"
import { expect, test } from "bun:test"
import { loadConfig } from "../src/config"

const env = {
  ...agentGitTestEnvironment,
  GITHUB_APP_ID: "123",
  WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
  GITHUB_PRIVATE_KEY_PATH: "/unused/key",
  GITHUB_WEBHOOK_SECRET: "secret",
  OPENCODE_SERVER_PASSWORD: "password",
  WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
  WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
}

test.each([
  undefined,
  "",
  " ",
  "81005232,",
  "BNasraoui",
  "1.5",
  "1e3",
  "-1",
  "0",
  "9007199254740992",
  "81005232,81005232",
  "01",
  "1, 1",
])("automation rejects invalid installation account allowlist: %s", async (value) => {
  await expect(
    loadConfig({ ...env, WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: value }),
  ).rejects.toThrow("WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS")
})

test("accepts immutable IDs and ignores login spelling", async () => {
  const config = await loadConfig({
    ...env,
    WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232, 319835875",
  })
  expect(config.github.allowedInstallationAccountIds).toEqual([81005232, 319835875])
})

test("execution mode does not require installation authority", async () => {
  expect((await loadConfig({ WORKFLOWD_MODE: "execution" })).github).toBeUndefined()
})

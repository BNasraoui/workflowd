import { expect, test } from "bun:test"
import { loadConfig } from "../src/config"

const environment = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY_PATH: "/unused/key",
  GITHUB_WEBHOOK_SECRET: "secret",
  WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232",
  WORKFLOWD_PR_REPOSITORIES: '[{"repository":"owner/repo","installationId":91}]',
  OPENCODE_SERVER_PASSWORD: "secret",
  WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-secret",
  WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
  WORKFLOWD_AGENT_GIT_NAME: "Agent",
  WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
}

test.each([undefined, "", "  \t\n"])(
  "PR repositories require a nonempty blocklist: %s",
  async (policy) => {
    await expect(
      loadConfig({ ...environment, WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS: policy }),
    ).rejects.toThrow("WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS")
  },
)

test("accepts a configured PR blocklist", async () => {
  const config = await loadConfig({
    ...environment,
    WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS: "blocked@example.test",
  })
  expect(config.agentGit?.blockedEmails).toEqual(["blocked@example.test"])
})

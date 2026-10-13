import { expect, test } from "bun:test"
import { loadConfig } from "../src/config"

const environment = {
  GITHUB_APP_ID: "123",
  WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
  GITHUB_PRIVATE_KEY_PATH: "/fixture/key",
  GITHUB_WEBHOOK_SECRET: "secret",
  OPENCODE_SERVER_PASSWORD: "secret",
  WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
}

test.each([
  undefined,
  "",
  "[]",
  "null",
  "not json",
  '[{"repository":"owner/repo","installationId":9007199254740992}]',
  '[{"repository":"owner/repo","installationId":0}]',
  '[{"repository":"*","installationId":91}]',
  '[{"repository":"owner/repo","installationId":1.5}]',
  '[{"repository":"owner/repo","installationId":91},{"repository":"OWNER/REPO","installationId":92}]',
])("automation startup refuses invalid PR allowlist %s", async (value) => {
  await expect(loadConfig({ ...environment, WORKFLOWD_PR_REPOSITORIES: value })).rejects.toThrow(
    "WORKFLOWD_PR_REPOSITORIES",
  )
})

test.each([91, 92])("loads repository pairs with second installation %s", async (secondId) => {
  const config = await loadConfig({
    ...environment,
    WORKFLOWD_PR_REPOSITORIES: JSON.stringify([
      { repository: "Owner/Repo", installationId: 91 },
      { repository: "Owner/Second", installationId: secondId },
    ]),
  })
  expect(config.github.prRepositories).toEqual([
    { repository: "owner/repo", installationId: 91 },
    { repository: "owner/second", installationId: secondId },
  ])
})

test("execution mode does not require a PR allowlist", async () => {
  expect((await loadConfig({ WORKFLOWD_MODE: "execution" })).github).toBeUndefined()
})

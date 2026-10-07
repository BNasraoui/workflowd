import { expect, test } from "bun:test"
import { loadConfig } from "../src/config"

const environment = {
  GITHUB_APP_ID: "123",
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
  '[{"repository":"owner/repo","installationId":0}]',
  '[{"repository":"*","installationId":91}]',
  '[{"repository":"owner/repo","installationId":1.5}]',
  '[{"repository":"owner/repo","installationId":91},{"repository":"OWNER/REPO","installationId":92}]',
])("automation startup refuses invalid PR allowlist %s", async (value) => {
  await expect(loadConfig({ ...environment, WORKFLOWD_PR_REPOSITORIES: value })).rejects.toThrow(
    "WORKFLOWD_PR_REPOSITORIES",
  )
})

test("loads and normalizes explicit repository/installation pairs", async () => {
  const config = await loadConfig({
    ...environment,
    WORKFLOWD_PR_REPOSITORIES: JSON.stringify([
      { repository: "Owner/Repo", installationId: 91 },
      { repository: "Owner/Second", installationId: 92 },
    ]),
  })
  expect(config.github.prRepositories).toEqual([
    { repository: "owner/repo", installationId: 91 },
    { repository: "owner/second", installationId: 92 },
  ])
})

test("execution mode does not require a PR allowlist", async () => {
  expect((await loadConfig({ WORKFLOWD_MODE: "execution" })).github).toBeUndefined()
})

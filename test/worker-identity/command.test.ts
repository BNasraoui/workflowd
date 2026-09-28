import { expect, test } from "bun:test"
import { workerCommandEnvironment } from "../../src/worker-identity/command-env"
test("command credentials override personal tokens and disable gh auth fallback", () => {
  const env = workerCommandEnvironment(
    {
      GH_TOKEN: "personal",
      GITHUB_TOKEN: "personal",
      GH_HOST: "other",
      GH_ENTERPRISE_TOKEN: "personal",
      HOME: "/home/test",
    },
    "app-token",
  )
  expect(env.GH_TOKEN).toBe("app-token")
  expect(env.GITHUB_TOKEN).toBe("app-token")
  expect(env.GH_HOST).toBe("github.com")
  expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined()
  expect(env.HOME).toBe("/home/test")
})

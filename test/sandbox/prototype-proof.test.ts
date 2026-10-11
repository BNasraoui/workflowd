import { describe, expect, test } from "bun:test"
import { parseSandboxRepositories } from "../../src/sandbox/config"

const policy = {
  alias: "demo",
  repository: "owner/demo",
  repositoryId: 1,
  installationId: 2,
  workflowSha: "a".repeat(40),
  appActorId: 3,
  tailscaleClientId: "client",
  tailscaleAudience: "audience",
}

describe("parseSandboxRepositories", () => {
  test("parses a valid policy", () => {
    expect(parseSandboxRepositories(JSON.stringify([policy]))).toEqual([policy])
  })

  test("rejects duplicate aliases", () => {
    const other = { ...policy, alias: "DEMO", repository: "owner/other", repositoryId: 9 }
    expect(() => parseSandboxRepositories(JSON.stringify([policy, other]))).toThrow(
      "Duplicate sandbox alias",
    )
  })

  test("rejects an invalid workflow SHA", () => {
    expect(() =>
      parseSandboxRepositories(JSON.stringify([{ ...policy, workflowSha: "not-a-sha" }])),
    ).toThrow()
  })
})

import { describe, expect, test } from "bun:test"
import { parseSandboxRepositories } from "../../src/sandbox/config"

const policy = {
  alias: "workflowd",
  repository: "owner/workflowd",
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
    const duplicate = {
      ...policy,
      alias: "WORKFLOWD",
      repository: "owner/other",
      repositoryId: 4,
    }
    expect(() => parseSandboxRepositories(JSON.stringify([policy, duplicate]))).toThrow(
      "Duplicate sandbox alias",
    )
  })

  test("rejects an invalid workflow SHA", () => {
    expect(() =>
      parseSandboxRepositories(JSON.stringify([{ ...policy, workflowSha: "not-a-sha" }])),
    ).toThrow()
  })
})

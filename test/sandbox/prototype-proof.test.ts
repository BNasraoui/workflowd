import { expect, test } from "bun:test"
import { parseSandboxRepositories } from "../../src/sandbox/config"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
}

test("parseSandboxRepositories accepts a valid sandbox policy", () => {
  expect(parseSandboxRepositories(JSON.stringify([policy]))).toEqual([policy])
})

test("parseSandboxRepositories rejects duplicate sandbox aliases", () => {
  expect(() => parseSandboxRepositories(JSON.stringify([policy, policy]))).toThrow(
    "Duplicate sandbox alias",
  )
})

test("parseSandboxRepositories rejects an invalid workflow SHA", () => {
  expect(() =>
    parseSandboxRepositories(JSON.stringify([{ ...policy, workflowSha: "main" }])),
  ).toThrow()
})

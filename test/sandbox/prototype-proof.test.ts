import { expect, test } from "bun:test"
import { parseSandboxRepositories } from "../../src/sandbox/config"

const policy = {
  alias: "sandbox",
  repository: "example/repository",
  repositoryId: 1,
  installationId: 2,
  workflowSha: "a".repeat(40),
  appActorId: 3,
  tailscaleClientId: "sandbox-client",
  tailscaleAudience: "sandbox-audience",
}

test("parseSandboxRepositories accepts a valid policy", () => {
  expect(parseSandboxRepositories(JSON.stringify([policy]))).toEqual([policy])
})

test("parseSandboxRepositories rejects duplicate aliases case-insensitively", () => {
  const duplicate = {
    ...policy,
    alias: "SANDBOX",
    repository: "example/another-repository",
    repositoryId: 4,
  }

  expect(() => parseSandboxRepositories(JSON.stringify([policy, duplicate]))).toThrow(
    "Duplicate sandbox alias",
  )
})

test("parseSandboxRepositories rejects an invalid workflow SHA", () => {
  const invalid = { ...policy, workflowSha: "g".repeat(40) }

  expect(() => parseSandboxRepositories(JSON.stringify([invalid]))).toThrow(/workflowSha/)
})

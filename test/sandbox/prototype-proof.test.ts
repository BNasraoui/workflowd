import { expect, test } from "bun:test"
import { parseSandboxRepositories } from "../../src/sandbox/config"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  tailscaleClientId: "THoBEY9Hwh11CNTRL-k4vtf1dX8811CNTRL",
  tailscaleAudience: "api.tailscale.com/THoBEY9Hwh11CNTRL-k4vtf1dX8811CNTRL",
}

test("parseSandboxRepositories accepts a valid sandbox policy", () => {
  expect(parseSandboxRepositories(JSON.stringify([policy]))).toEqual([policy])
})

test("parseSandboxRepositories rejects duplicate aliases", () => {
  const duplicate = { ...policy, repository: "BNasraoui/other", repositoryId: 42 }
  expect(() => parseSandboxRepositories(JSON.stringify([policy, duplicate]))).toThrow(
    "Duplicate sandbox alias",
  )
})

test("parseSandboxRepositories rejects an invalid workflow SHA", () => {
  expect(() => parseSandboxRepositories(JSON.stringify([{ ...policy, workflowSha: "main" }]))).toThrow()
})

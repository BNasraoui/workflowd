import { expect, test } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { sharedOpenCodeFixture } from "./opencode-fixture"
import { makeSandboxOpenCode } from "../../src/sandbox/opencode"
import { bindingDirectory, sandboxPolicyHash, writeSandboxBinding } from "../../src/sandbox/binding"

// A real SDK/HTTP failure, including the authenticated request object, must reduce
// to classification only before it reaches terminal storage.
for (const [stage, path] of [
  ["preflight", "/health"],
  ["session", "/session/"],
  ["catalog", "/mcp"],
] as const) {
  test(`sandbox ${stage} observation preserves HTTP classification without credentials`, async () => {
    const shared = await sharedOpenCodeFixture(`observe-${stage}`)
    const directory = join(shared.root, "owned")
    try {
      await mkdir(directory)
      const sessionId = await shared.create(directory, "sandbox")
      const location = await Effect.runPromise(
        shared.client.location.get({ location: { directory } }),
      )
      const binding = {
        runId: "run-1",
        leaseId: "lease-1",
        sessionId,
        executorId: "opencode:fixture",
        endpointIdentity: shared.url,
        directory,
        locationIdentity: location.project.id,
        bridgeServerName: "wfdlease_lease_1",
        repositoryId: 1,
        sourceSha: "a".repeat(40),
        policyHash: sandboxPolicyHash,
        transportHash: "b".repeat(64),
        deadline: Date.now() + 60000,
        state: "active" as const,
      }
      await writeSandboxBinding(binding, true)
      shared.reject({ path: stage === "session" ? path + sessionId : path, status: 503 })
      const result = await Effect.runPromise(
        makeSandboxOpenCode(shared.client, shared.executor).check(binding).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          evidence: { stage, errorClass: "DecodeError", httpStatus: 503 },
        })
        expect(JSON.stringify(result.failure)).not.toContain("fixture-server-password")
        expect(JSON.stringify(result.failure)).not.toContain("Authorization")
      }
    } finally {
      shared.reject()
      await rm(bindingDirectory(directory), { recursive: true, force: true })
      await shared.close()
    }
  }, 60000)
}

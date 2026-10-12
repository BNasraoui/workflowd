import { expect, test } from "bun:test"
import { probeCodexCredentialSharing } from "./harness"

test("installed Codex preserves the canonical credential store through re-login", async () => {
  const evidence = await probeCodexCredentialSharing()
  expect(evidence.directUpdateShared).toBe(true)
  expect(evidence.relogin.controllerSeesReplacement).toBe(true)
  // This prerequisite must pass before provisioning or any cross-UID rollout.
  expect(evidence.relogin).toEqual({
    controllerLinkPreserved: true,
    controllerSeesReplacement: true,
    canonicalSeesReplacement: true,
    agentSeesReplacement: true,
  })
}, 90_000)

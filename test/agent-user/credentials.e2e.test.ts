import { expect, test } from "bun:test"
import { probeCodexCredentialSharing, probeInstalledRefresh } from "./harness"

test("installed Codex re-login breaks sharing, then production relink restores shared use", async () => {
  const evidence = await probeCodexCredentialSharing()
  expect(evidence.directUpdateShared).toBe(true)
  expect(evidence.relogin.controllerSeesReplacement).toBe(true)
  expect(evidence.relogin.controllerLinkPreserved).toBe(false)
  expect(evidence.refusal).toBe("shared_credential_diverged")
  expect(evidence.repaired).toBe(true)
}, 90_000)

test("installed clients refresh synthetic OAuth credentials with external egress denied", async () => {
  const evidence = await probeInstalledRefresh()
  expect(evidence.egressDenied).toBe(true)
  expect(evidence.uidCount).toBe(process.env.WORKFLOWD_AGENT_TEST_BEN_UID ? 2 : 1)
  expect(evidence.canariesDenied).toBe(true)
  expect(evidence.codex.refreshPersisted).toBe(true)
  expect(evidence.claude.refreshPersisted).toBe(true)
  expect(evidence.claude.linkPreserved).toBe(false)
  expect(evidence.claude.refusal).toBe("shared_credential_diverged")
  expect(evidence.claude.repaired).toBe(true)
}, 150_000)

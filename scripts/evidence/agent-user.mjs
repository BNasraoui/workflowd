#!/usr/bin/env bun
import {
  probeCodexCredentialSharing,
  probeInstalledRefresh,
} from "../../test/agent-user/harness.ts"

if (process.argv.length !== 3 || process.argv[2] !== "--probe-credentials") {
  console.error("Usage: bun scripts/evidence/agent-user.mjs --probe-credentials")
  process.exitCode = 2
} else {
  try {
    const evidence = await probeCodexCredentialSharing()
    const refresh = await probeInstalledRefresh()
    const compatible =
      evidence.directUpdateShared &&
      evidence.refusal === "shared_credential_diverged" &&
      evidence.repaired &&
      refresh.codex.refreshPersisted &&
      refresh.claude.refreshPersisted &&
      refresh.claude.repaired
    console.log(
      JSON.stringify({
        ...evidence,
        refresh,
        status: compatible ? "prerequisite-passed" : "blocked",
        crossUidRefreshVerified: refresh.uidCount === 2,
      }),
    )
    if (!compatible) process.exitCode = 1
  } catch {
    // Never forward client output, credentials or environment into evidence logs.
    console.error("Credential probe could not complete; provisioning remains blocked")
    process.exitCode = 2
  }
}

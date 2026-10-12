#!/usr/bin/env bun
import { probeCodexCredentialSharing } from "../../test/agent-user/harness.ts"

if (process.argv.length !== 3 || process.argv[2] !== "--probe-credentials") {
  console.error("Usage: bun scripts/evidence/agent-user.mjs --probe-credentials")
  process.exitCode = 2
} else {
  try {
    const evidence = await probeCodexCredentialSharing()
    const compatible = evidence.directUpdateShared && Object.values(evidence.relogin).every(Boolean)
    console.log(
      JSON.stringify({
        ...evidence,
        status: compatible ? "prerequisite-passed" : "blocked",
        crossUidRefreshVerified: false,
      }),
    )
    if (!compatible) process.exitCode = 1
  } catch {
    // Never forward client output, credentials or environment into evidence logs.
    console.error("Credential probe could not complete; provisioning remains blocked")
    process.exitCode = 2
  }
}

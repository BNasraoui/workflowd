import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { open } from "node:fs/promises"

for (const client of ["codex", "opencode2"] as const) {
  test(`pinned ${client} native tools, same-session resume and sleeping-tool cancellation`, async () => {
    const log = await open(`/tmp/opencode/evidence/${client}-lifecycle.log`, "wx", 0o600)
    const child = spawn("python3", ["scripts/evidence/native-protocol.py", client, "--custodian"], {
      stdio: ["ignore", log.fd, log.fd],
    })
    const closed = new Promise((resolve) => child.once("close", resolve))
    const timer = setTimeout(() => child.kill("SIGKILL"), 100000)
    try {
      expect(await closed).toBe(0)
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
      await closed
      await log.close()
    }
  }, 105000)
}

import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { open } from "node:fs/promises"

for (const operation of ["finish", "cancel"]) {
  test(`native custodian retains an exited group leader through delayed ${operation}`, async () => {
    const log = await open(`/tmp/opencode/evidence/native-group-${operation}.log`, "wx", 0o600)
    const child = spawn("python3", ["test/sandbox/fixtures/native-client-custody.py", operation], {
      stdio: ["ignore", log.fd, log.fd],
    })
    const closed = new Promise((resolve) => child.once("close", resolve))
    const timeout = setTimeout(() => child.kill("SIGKILL"), 12000)
    try {
      expect(await closed).toBe(0)
    } finally {
      clearTimeout(timeout)
      child.kill("SIGKILL")
      await closed
      await log.close()
    }
  }, 15000)
}

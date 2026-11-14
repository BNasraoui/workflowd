import { expect, test } from "bun:test"
import { resolve } from "node:path"

for (const writer of ["run", "lease"])
  test(`S5: actual ${writer} writer composes with an outer SQLite transaction`, async () => {
    // Separate process: the regressed uninterruptible lock inversion cannot hang
    // this test's cleanup or the supervisor. No gateway is needed to reproduce it.
    const child = Bun.spawn(
      [process.execPath, resolve("test/capability-gateway/transaction-fixture.ts"), writer],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000)
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    clearTimeout(timeout)
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  }, 5000)

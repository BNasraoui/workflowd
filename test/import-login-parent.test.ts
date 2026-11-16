import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { rm, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  claudeLogin,
  custodyEnv,
  fixture,
  importLogin,
  syntheticValue,
} from "./capability-gateway/gateway-process"
import { mode } from "./capability-gateway/custody-fixture"

/**
 * The gateway's `import-login` under a parent directory of another user. The case needs a
 * directory of another user that this uid may write to, the system's `/tmp`; the isolated
 * capability suites, which run each file of `test/capability-gateway`, have none, so this file
 * is outside that directory and runs in the plain test run.
 */

test("import-login makes a new login directory under a parent of another user for its own uid, mode 0700: the owner of the parent decides nothing", async () => {
  const f = await fixture()
  const below = join("/tmp", `wfd-login-${randomUUID()}`)
  try {
    expect((await stat("/tmp")).uid).not.toBe(process.getuid!())
    const login = claudeLogin(
      syntheticValue("access"),
      syntheticValue("refresh"),
      Date.now() + 3600000,
    )
    expect(await importLogin(custodyEnv(f, below), JSON.stringify(login))).toEqual({
      code: 0,
      stdout: `imported the claude login, owned by uid ${process.getuid!()}\n`,
      stderr: "",
    })
    expect([(await stat(below)).uid, await mode(below)]).toEqual([process.getuid!(), "0700"])
  } finally {
    await rm(below, { recursive: true, force: true })
    await f.close()
  }
})

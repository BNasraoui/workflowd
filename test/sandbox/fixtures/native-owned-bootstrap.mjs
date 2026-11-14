// Production Node bootstrap/runner relay with a synthetic signed job identity.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { serveBootstrap } from "/source/deploy/sandbox/bootstrap.mjs"

const root = "/evidence/native-runtime"
const input = JSON.parse(await readFile(`${root}/bootstrap-input.json`, "utf8"))
let relay
let closed
const helper = await serveBootstrap({
  directory: root,
  identity: input.identity,
  issue: async (audience) => {
    assert.equal(audience, input.audience)
    return input.token
  },
  activate: async (grant) => {
    assert.equal(grant.mode, "actions-native")
    relay = spawn("/bin/node", ["/source/deploy/sandbox/capability-relay.mjs", "runner"], {
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
      stdio: ["pipe", "pipe", "inherit"],
    })
    closed = once(relay, "close")
    relay.stdin.end(JSON.stringify(grant))
    const [ready] = await once(relay.stdout, "data")
    assert.equal(ready.toString(), "ready\n")
  },
})
process.once("SIGTERM", async () => {
  helper.close()
  relay?.kill("SIGTERM")
  await closed
})
console.log("ready")
try {
  await helper.completed
} catch (error) {
  relay?.kill("SIGTERM")
  await closed
  throw error
}

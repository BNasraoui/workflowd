import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:https"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { serveRunnerRelay } from "../../../deploy/sandbox/capability-relay.mjs"
import { relayConfig } from "./relay-config.mjs"

test("renewal never sends an expired predecessor after a clock jump", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-clock-"))
  const server = createServer({
    key: await readFile(process.env.RELAY_CLOCK_KEY),
    cert: await readFile(process.env.NODE_EXTRA_CA_CERTS),
  })
  let attempts = 0
  const first = Promise.withResolvers()
  server.on("request", (request, response) => {
    request.resume()
    request.once("end", () => {
      attempts++
      response.writeHead(503)
      response.end()
      first.resolve()
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const now = 1000000
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })
  const relay = await serveRunnerRelay(relayConfig(now, server.address().port), root)
  try {
    t.mock.timers.tick(2700000)
    await first.promise
    await setImmediate()
    assert.equal(attempts, 1)
    // The clock jumps past the token's expiry before the retry: nothing more is sent.
    t.mock.timers.tick(3600000)
    await new Promise((resolve) => globalThis.setImmediate(resolve))
    assert.equal(attempts, 1)
    t.mock.timers.tick(7200000)
    assert.equal(attempts, 1)
    // The relay names the expiry of its token as the reason it ended the session.
    assert.equal(await readFile(join(root, "relay-ended"), "utf8"), "expiry\n")
  } finally {
    relay.close()
    server.closeAllConnections()
    server.close()
    t.mock.timers.reset()
    await rm(root, { recursive: true, force: true })
  }
})

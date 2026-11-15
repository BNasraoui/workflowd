import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:https"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveRunnerRelay } from "../../../deploy/sandbox/capability-relay.mjs"

test("a renewal answered after stop sends no further request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-stop-"))
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
      first.resolve(response)
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const now = Date.now()
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })
  const relay = await serveRunnerRelay(
    {
      token: "a".repeat(43),
      expiresAt: now + 3600000,
      renewAt: now + 2700000,
      deadline: now + 7200000,
      gateway: `https://127.0.0.1:${server.address().port}`,
    },
    root,
  )
  try {
    t.mock.timers.tick(2700000)
    const response = await first.promise
    relay.close()
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        token: "b".repeat(43),
        expiresAt: now + 3600000 + 900000,
        renewAt: now + 2700000 + 60000,
      }),
    )
    await once(response, "finish")
    for (let cycle = 0; cycle < 50; cycle++)
      await new Promise((resolve) => globalThis.setImmediate(resolve))
    for (let step = 0; step < 10; step++) {
      t.mock.timers.tick(600000)
      await new Promise((resolve) => globalThis.setImmediate(resolve))
    }
    assert.equal(attempts, 1)
  } finally {
    relay.close()
    server.closeAllConnections()
    server.close()
    t.mock.timers.reset()
    await rm(root, { recursive: true, force: true })
  }
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { Agent, createServer } from "node:https"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveRunnerRelay } from "../../../deploy/sandbox/capability-relay.mjs"

/** Runs the event loop for `cycles` turns; the mocked timers do not move. */
const turns = async (cycles) => {
  for (let cycle = 0; cycle < cycles; cycle++)
    await new Promise((resolve) => globalThis.setImmediate(resolve))
}

// The real timers, kept before a test mocks `setTimeout`: the bound below runs on the wall clock.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/** Whether `socket` emits `close` within `ms` milliseconds of real time. */
const closesWithin = async (socket, ms) => {
  let timer
  const late = new Promise((resolve) => {
    timer = realSetTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([once(socket, "close").then(() => true), late])
  } finally {
    realClearTimeout(timer)
  }
}

/**
 * A relay whose renewal is in flight at a gateway that has not answered it yet. `body` gets the
 * relay, the gateway's pending response and request, and the count of renewal requests.
 */
async function renewalInFlight(t, body) {
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
      first.resolve({ request, response })
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
      providerId: "anthropic",
      gateway: `https://127.0.0.1:${server.address().port}`,
    },
    root,
  )
  try {
    t.mock.timers.tick(2700000)
    const { request, response } = await first.promise
    await body({ relay, request, response, now, attempts: () => attempts })
  } finally {
    relay.close()
    server.closeAllConnections()
    server.close()
    t.mock.timers.reset()
    await rm(root, { recursive: true, force: true })
  }
}

test("stop cuts the connection of a renewal in flight", async (t) => {
  await renewalInFlight(t, async ({ relay, request }) => {
    const closed = closesWithin(request.socket, 3000)
    relay.close()
    assert.equal(await closed, true)
  })
})

test("a renewal answered after stop sends no further request, also when the agent keeps its connection", async (t) => {
  // An agent whose destroy cuts nothing: the stop must not depend on the agent's internals.
  t.mock.method(Agent.prototype, "destroy", function () {
    return this
  })
  await renewalInFlight(t, async ({ relay, response, now, attempts }) => {
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
    await turns(50)
    for (let step = 0; step < 10; step++) {
      t.mock.timers.tick(600000)
      await turns(1)
    }
    assert.equal(attempts(), 1)
  })
})

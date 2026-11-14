import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http2"
import { connect } from "node:net"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { serveRunnerRelay } from "../../../deploy/sandbox/capability-relay.mjs"

test("renewal never sends an expired predecessor after a clock jump", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-clock-"))
  const now = 1000000
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })
  const server = createServer()
  let attempts = 0
  const first = Promise.withResolvers()
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    stream.resume()
    stream.once("end", () => {
      attempts++
      stream.respond({ ":status": 503 })
      stream.end()
      stream.once("close", first.resolve)
    })
  })
  const relay = await serveRunnerRelay(
    {
      token: "a".repeat(43),
      expiresAt: now + 3600000,
      renewAt: now + 2700000,
      deadline: now + 7200000,
    },
    root,
  )
  const connected = once(server, "session")
  const socket = connect(join(root, "capability.sock"))
  server.emit("connection", socket)
  try {
    const [session] = await connected
    session.on("error", () => {})
    await once(session, "remoteSettings")
    t.mock.timers.tick(2700000)
    await first.promise
    await setImmediate()
    assert.equal(attempts, 1)
    const closed = once(session, "close")
    t.mock.timers.tick(900000)
    await closed
    assert.equal(attempts, 1)
    t.mock.timers.tick(7200000)
    assert.equal(attempts, 1)
  } finally {
    relay.close()
    socket.destroy()
    server.close()
    t.mock.timers.reset()
    await rm(root, { recursive: true, force: true })
  }
})

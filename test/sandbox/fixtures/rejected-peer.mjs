import assert from "node:assert/strict"
import { connect, constants } from "node:http2"
import { Duplex, Transform } from "node:stream"
import { once } from "node:events"

if (process.argv[2] !== "resets") {
  const preface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
  const input =
    process.argv[2] === "preface"
      ? Buffer.from("invalid-http2-preface\r\n\r\n")
      : Buffer.concat([
          preface,
          process.argv[2] === "settings"
            ? Buffer.from([0, 0, 1, 4, 0, 0, 0, 0, 0, 0])
            : Buffer.from([0, 0, 6, 4, 0]),
        ])
  await new Promise((resolve) => process.stdout.write(input, resolve))
  process.exit(0)
}

// Coalesce a peer error reset with the rejected HEADERS frame. Waiting for the
// 403 would let Node finish its refusal before the adversarial reset arrives.
let preface = true
let pending = Buffer.alloc(0)
let sent
const output = new Transform({
  transform(chunk, _, done) {
    pending = Buffer.concat([pending, chunk])
    if (preface) {
      if (pending.length < 24) return done()
      this.push(pending.subarray(0, 24))
      pending = pending.subarray(24)
      preface = false
    }
    while (pending.length >= 9) {
      const size = pending.readUIntBE(0, 3) + 9
      if (pending.length < size) break
      const frame = pending.subarray(0, size)
      pending = pending.subarray(size)
      const id = frame.readUInt32BE(5)
      if (frame[3] === 1 && id % 8 === 1) {
        const reset = Buffer.from([0, 0, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 2])
        reset.writeUInt32BE(id, 5)
        this.push(Buffer.concat([frame, reset]))
        sent?.()
      } else this.push(frame)
    }
    done()
  },
})
output.pipe(process.stdout)

const session = connect("http://capability.invalid", {
  createConnection: () => Duplex.from({ readable: process.stdin, writable: output }),
})
session.on("error", () => {})
for (let i = 0; i < 8; i++) {
  const transmitted = new Promise((resolve) => {
    sent = resolve
  })
  const bad = session.request(
    {
      ":method": "POST",
      ":path": i % 2 ? "/capabilities/v1/renew" : "/refused",
      ":authority": "capability.invalid",
      ...(i % 2 ? { host: "foreign.invalid" } : {}),
    },
    { endStream: false },
  )
  bad.on("error", () => {})
  const reset = new Promise((resolve) => bad.once("close", resolve))
  if (i % 2) assert.equal((await once(bad, "response"))[0][":status"], 403)
  else await transmitted
  bad.close(constants.NGHTTP2_INTERNAL_ERROR)
  await reset
  const good = session.request({
    ":method": "POST",
    ":path": "/capabilities/v1/renew",
    ":authority": "capability.invalid",
  })
  good.end("{}")
  let text = ""
  for await (const chunk of good) text += chunk.toString()
  assert.equal(text, "fixture-valid")
}
const closed = once(session, "close")
session.close()
await closed

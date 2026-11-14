// Synthetic native client. The SSH forced command runs this in an isolated netns.
import assert from "node:assert/strict"
import { connect, constants } from "node:http2"
import { Duplex } from "node:stream"
import { once } from "node:events"

const client = connect("http://capability.invalid", {
  createConnection: () => Duplex.from({ readable: process.stdin, writable: process.stdout }),
  settings: { initialWindowSize: 65535, maxConcurrentStreams: 8 },
})
const body = Buffer.from(
  '{"model":"synthetic","messages":[{"role":"user","content":"hello"}],"stream":true}',
)
const request = (path) => {
  const stream = client.request({
    ":method": "POST",
    ":path": path,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  })
  stream.end(body)
  return stream
}

// Keep a slow consumer open while ordinary streams complete on the same session.
const slow = request("/slow")
await once(slow, "response")
const cancelled = request("/cancel")
await once(cancelled, "data")
cancelled.close(constants.NGHTTP2_CANCEL)
await once(cancelled, "close")
await Promise.all(
  Array.from({ length: 4 }, async (_, index) => {
    const stream = request(`/messages/${index}`)
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.equal(
      Buffer.concat(chunks).toString(),
      `event: message_start\ndata: {"id":${index}}\n\nevent: message_stop\ndata: {}\n\n`,
    )
  }),
)
slow.close(constants.NGHTTP2_CANCEL)
await once(slow, "close")
const receipt = request("/receipt")
receipt.resume()
await once(receipt, "end")
client.close()
await once(client, "close")

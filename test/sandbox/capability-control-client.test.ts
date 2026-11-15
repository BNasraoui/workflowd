import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { controlFrame } from "../../src/capability-control/protocol"
import { controlClient } from "../../src/sandbox/capability-control"

/**
 * workflowd's control client against a stand-in gateway on a Unix socket: the stand-in reads no
 * request, writes one complete answer frame, and then closes with the request unread, so the
 * client's connection fails with a reset after the answer.
 */
test("the control client gives a complete answer that came before a reset of the connection, not an unavailable gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-control-client-"))
  const socket = join(root, "gateway.sock")
  const errors: string[] = []
  const server = createServer({ pauseOnConnect: true }, (connection: Socket) => {
    connection.on("error", () => {})
    connection.write(controlFrame({ ok: false, error: "caller" }))
    setTimeout(() => connection.destroy(), 200)
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await Effect.runPromise(Effect.flip(controlClient(socket).revoke("run")))
      errors.push(`${result._tag}: ${result.reason}`)
    }
    expect(errors).toEqual(Array.from({ length: 5 }, () => "CapabilityControlRefused: caller"))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
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

/**
 * A stand-in gateway on a Unix socket that reads the client's request and passes each
 * connection to `serve`; `held` resolves once it holds a whole request.
 */
async function standIn(serve: (connection: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), "wfd-control-client-"))
  const socket = join(root, "gateway.sock")
  const held = Promise.withResolvers<void>()
  const server = createServer((connection: Socket) => {
    let request = Buffer.alloc(0)
    connection.on("error", () => {})
    connection.on("data", (chunk) => {
      request = Buffer.concat([request, Buffer.from(chunk)])
      if (request.length < 4 || request.readUInt32BE(0) !== request.length - 4) return
      held.resolve()
      serve(connection)
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return {
    socket,
    held: held.promise,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("the control client takes an answer cut short, or one with bytes after its end, as no answer", async () => {
  const frame = controlFrame({ ok: true, value: null })
  for (const sent of [
    frame.subarray(0, frame.length - 1),
    Buffer.concat([frame, Buffer.from("x")]),
  ]) {
    const gateway = await standIn((connection) => connection.end(sent))
    try {
      const result = await Effect.runPromise(
        Effect.flip(controlClient(gateway.socket).revoke("run")),
      )
      expect(`${result._tag}: ${result.reason}`).toBe(
        "CapabilityGatewayUnavailable: control answer cut short",
      )
    } finally {
      await gateway.close()
    }
  }
})

test("a control call that the gateway holds unanswered fails as unavailable at the end of its time limit", async () => {
  const gateway = await standIn(() => undefined)
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const call = yield* Effect.forkChild(
          Effect.flip(controlClient(gateway.socket).revoke("run")),
        )
        yield* Effect.promise(() => gateway.held)
        // The test's clock: the call's time limit ends only when the test moves it.
        yield* TestClock.adjust("15 seconds")
        return yield* Fiber.join(call)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(`${result._tag}: ${result.reason}`).toBe("CapabilityGatewayUnavailable: timed out")
  } finally {
    await gateway.close()
  }
})

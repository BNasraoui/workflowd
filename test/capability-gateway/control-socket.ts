import { createConnection } from "node:net"
import { join } from "node:path"
import { processGateway, type Fixture } from "./gateway-process"

/**
 * The control socket's fixtures: the gateway process alone with its own store and control
 * socket, and raw connections to that socket.
 */

/** The gateway's section with its own store, control socket and the daemon's ids. */
export const gatewayConfig = (f: Fixture, daemonUid = process.getuid!()) => ({
  ...f.config,
  storePath: join(f.root, "gateway.db"),
  controlSocket: join(f.root, "control", "gateway.sock"),
  daemon: { uid: daemonUid, gid: process.getgid!() },
})

/** The gateway process alone: here the daemon process, not this one, makes every control call. */
export const startGateway = (f: Fixture, config: object = gatewayConfig(f)) =>
  processGateway({
    ...f,
    env: {
      PATH: process.env.PATH,
      HOME: f.root,
      TMPDIR: f.root,
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config),
    },
    reconcile: async () => undefined,
  })

export const socketOf = (f: Fixture) => join(f.root, "control", "gateway.sock")

/**
 * A connection to the control socket that sends nothing until the test writes to it. `closed`
 * resolves when it closes, to the answer, "closed" when there was none, or "error".
 */
export function openConnection(socket: string) {
  const connection = createConnection(socket)
  let answer = Buffer.alloc(0)
  const opened = new Promise<number>((done) =>
    connection.on("connect", () => done(performance.now())),
  )
  connection.on("data", (chunk) => {
    answer = Buffer.concat([answer, Buffer.from(chunk)])
  })
  const closed = new Promise<string>((done) => {
    connection.on("error", () => done("error"))
    connection.on("close", () =>
      done(answer.length >= 4 ? answer.subarray(4).toString("utf8") : "closed"),
    )
  })
  return { connection, opened, closed }
}

/** One raw frame on the control socket: a 4-byte length, then the bytes. */
export function rawFrame(socket: string, frame: Buffer) {
  const { connection, closed } = openConnection(socket)
  connection.on("connect", () => connection.write(frame))
  return closed
}
export const framed = (body: string | Buffer, length?: number) => {
  const bytes = typeof body === "string" ? Buffer.from(body) : body
  const header = Buffer.alloc(4)
  header.writeUInt32BE(length ?? bytes.length)
  return Buffer.concat([header, bytes])
}

/**
 * A connection to the control socket that keeps its own side open after the gateway ends its
 * side. `answer` resolves to the answer when the gateway ends its side, or "closed" when the
 * connection closes first; `closed` resolves when it closes; `errors` holds each error's code.
 */
export function halfOpenConnection(socket: string) {
  const connection = createConnection({ path: socket, allowHalfOpen: true })
  const errors: string[] = []
  let answer = Buffer.alloc(0)
  connection.on("data", (chunk) => {
    answer = Buffer.concat([answer, Buffer.from(chunk)])
  })
  connection.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? "error"))
  const text = () => (answer.length >= 4 ? answer.subarray(4).toString("utf8") : "closed")
  const closed = new Promise<void>((done) => connection.on("close", () => done()))
  const ended = new Promise<string>((done) => {
    connection.on("end", () => done(text()))
    connection.on("close", () => done(text()))
  })
  const opened = new Promise<void>((done) => connection.on("connect", () => done()))
  return { connection, opened, answer: ended, closed, errors }
}

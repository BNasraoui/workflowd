import { expect, test } from "bun:test"
import { createConnection, type Socket } from "node:net"
import { runnerAddress } from "../helpers/loopback-tls"
import { maxListenerConnections, maxPeerRequests } from "../../src/capability-gateway/http"
import { client, processGateway, proof, withGateway, type Fixture } from "./gateway-process"

/** How long a connection that the gateway keeps open must stay so, to count as held. */
const heldMs = 1500

/** A connection to the gateway's listener, as the front opens one, and what the gateway did. */
interface Attempt {
  readonly socket: Socket
  /**
   * The first line of the gateway's answer: `HTTP/1.1 100 Continue` once the gateway has taken
   * the request and waits for its body; `ended` when the gateway ended the connection with no
   * answer (Bun's client may report a connection that the server ends at accept as a refused
   * connect, which is the same here); `held` when the connection stays open with no answer.
   */
  readonly answer: string
  /** Milliseconds from the connect to the answer. */
  readonly ms: number
}

/**
 * Opens a connection to the listener of `f`, as the front does (this process has the front's
 * uid), and sends the head of a session post with Serve's headers for the runner at `peer` and
 * no body: a request that the gateway holds while it waits for the body, up to 10 s.
 */
const attempt = (f: Fixture, peer: string) =>
  new Promise<Attempt>((resolve) => {
    const started = performance.now()
    const socket = createConnection(f.config.listen.socket)
    let text = ""
    const settle = (answer: string) => {
      clearTimeout(timer)
      resolve({ socket, answer, ms: performance.now() - started })
    }
    const timer = setTimeout(() => settle(text === "" ? "held" : text.split("\r\n")[0]!), heldMs)
    socket.once("connect", () =>
      socket.write(
        [
          "POST /capabilities/v1/session HTTP/1.1",
          `host: ${f.front.service}`,
          `x-forwarded-for: ${peer}`,
          "x-forwarded-proto: https",
          `x-forwarded-host: ${f.front.service}`,
          "content-type: application/json",
          "content-length: 64",
          "expect: 100-continue",
          "",
          "",
        ].join("\r\n"),
      ),
    )
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1")
      if (text.includes("\r\n\r\n")) settle(text.split("\r\n")[0]!)
    })
    socket.on("error", () => socket.destroy())
    socket.once("close", () => settle(text === "" ? "ended" : text.split("\r\n")[0]!))
  })

const taken = "HTTP/1.1 100 Continue"

/** Tries a request of `peer` until the gateway takes it, at most `tries` times, 100 ms apart. */
const takenAgain = async (f: Fixture, peer: string, tries = 30) => {
  for (let tried = 1; ; tried++) {
    const next = await attempt(f, peer)
    if (next.answer === taken || tried === tries) return next
    next.socket.destroy()
    await Bun.sleep(100)
  }
}

test("the listener ends each connection above its bound at once, with no answer; a held connection that ends frees its place", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const bound = maxListenerConnections(f.config.maxStreams)
    const held: Array<Socket> = []
    try {
      // Each connection holds one request of a runner of its own, so no runner is at its bound.
      for (let index = 1; index <= bound; index++) {
        const next = await attempt(f, `100.64.1.${index}`)
        held.push(next.socket)
        expect(next.answer).toBe(taken)
      }
      const above = await attempt(f, "100.64.2.1")
      held.push(above.socket)
      expect(above.answer).toBe("ended")
      expect(above.ms).toBeLessThan(heldMs)
      // Through the front, a run's request meets the same end: the front answers 502.
      const runner = client(gateway)
      expect((await runner.challenge()).status).toBe(502)
      held[0]!.destroy()
      const freed = await takenAgain(f, "100.64.2.1")
      held.push(freed.socket)
      expect(freed.answer).toBe(taken)
    } finally {
      for (const socket of held) socket.destroy()
    }
  })
}, 60000)

test("a runner that holds its bound of requests gets each further connection ended at once, while another run opens its session; a held request that ends frees its place", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const flooding = "100.64.0.9"
    expect(flooding).not.toBe(runnerAddress)
    const held: Array<Socket> = []
    try {
      for (let index = 0; index < maxPeerRequests; index++) {
        const next = await attempt(f, flooding)
        held.push(next.socket)
        expect(next.answer).toBe(taken)
      }
      const above = await attempt(f, flooding)
      held.push(above.socket)
      expect(above.answer).toBe("ended")
      expect(above.ms).toBeLessThan(heldMs)
      // The run of the fixture's runner, through the front, gets its challenge and its session.
      const runner = client(gateway)
      const { audience } = await runner.audience()
      const session = await runner.session(proof(audience, "jti-bounds"))
      expect(session.status).toBe(200)
      expect((await runner.grant(session)).token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      held[0]!.destroy()
      const freed = await takenAgain(f, flooding)
      held.push(freed.socket)
      expect(freed.answer).toBe(taken)
    } finally {
      for (const socket of held) socket.destroy()
    }
  })
}, 60000)

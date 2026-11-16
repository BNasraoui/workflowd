import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { maxRenewalBody } from "../../deploy/sandbox/renewal.mjs"
import { runnerAddress } from "../helpers/loopback-tls"
import {
  client,
  processGateway,
  proof,
  sse,
  withGateway,
  type Fixture,
  type Gateway,
} from "./gateway-process"

/** The most bytes a model call's body may hold. */
const modelBodyLimit = 1048576

/** `text` as a request body of chunks of at most 64 KiB, which the client sends with no length. */
const chunked = (text: string) => {
  const bytes = Buffer.from(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 65536)
        controller.enqueue(bytes.subarray(at, at + 65536))
      controller.close()
    },
  })
}

/** Opens the seeded run's session and gives its run token and channel. */
async function opened(gateway: Gateway) {
  const runner = client(gateway)
  const { audience, channel } = await runner.audience()
  const grant = await runner.grant(await runner.session(proof(audience, "jti-over-bound")))
  return { token: grant.token, channel }
}

/**
 * Whether the gateway process has ended by now. A request's end runs before its answer reaches
 * the client, so an end that it caused has come once a later request is answered.
 */
const ended = (gateway: Gateway) =>
  Promise.race([gateway.exited!.then(() => true), Bun.sleep(100).then(() => false)])

/** A messages body of `bytes` bytes, as the agent sends one. */
const messagesOfSize = (bytes: number) => {
  const head =
    '{"model":"fixture-model","stream":true,"max_tokens":1000,"messages":[{"role":"user","content":"'
  const tail = '"}]}'
  return head + "a".repeat(bytes - head.length - tail.length) + tail
}

test("[process] a chunked renewal body one byte over its bound is refused, and the gateway goes on to answer the relay's next renewal and a call", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const relay = client(gateway)
    // A run token of 200 s is in its renewal window from its start.
    await f.tokenSeconds(200)
    const { token, channel } = await opened(gateway)
    await f.tokenSeconds(300)
    const over = "{".padEnd(maxRenewalBody + 1, " ")
    expect(Buffer.byteLength(over)).toBe(maxRenewalBody + 1)
    const refused = await relay.request("/capabilities/v1/renew", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: chunked(over),
    })
    expect({ status: refused.status, text: await refused.text() }).toEqual({
      status: 403,
      text: "",
    })
    const renewed = await relay.renew(token, channel)
    expect(renewed.status).toBe(200)
    expect(await (await relay.call((await relay.grant(renewed)).token)).text()).toBe(sse)
    expect(await ended(gateway)).toBe(false)
  })
}, 60000)

for (const framing of ["Content-Length", "chunks"] as const)
  test(`[process] a 2 MiB messages body sent with ${framing} is refused, and the gateway goes on to answer the next call`, async () => {
    await withGateway(processGateway, async (f, gateway) => {
      const runner = client(gateway)
      const { token } = await opened(gateway)
      const over = messagesOfSize(2 * modelBodyLimit)
      const refused = await runner.request("/capabilities/v1/providers/anthropic/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: framing === "chunks" ? chunked(over) : over,
      })
      expect(refused.status).toBe(403)
      await refused.arrayBuffer()
      expect(f.upstreamRequests()).toEqual([])
      expect(await (await runner.call(token)).text()).toBe(sse)
      expect(await ended(gateway)).toBe(false)
    })
  }, 60000)

/**
 * Sends on one connection to the listener of `f`, as the front does, a messages call of `token`
 * whose body is `body`, and then a challenge; gives the status line of each answer, in order.
 */
const twoOnOneConnection = (f: Fixture, token: string, body: string) =>
  new Promise<Array<string>>((resolve, reject) => {
    const socket = createConnection(f.config.listen.socket)
    const head = (lines: Array<string>) =>
      [
        ...lines,
        "host: localhost",
        `x-forwarded-for: ${runnerAddress}`,
        "x-forwarded-proto: https",
        `x-forwarded-host: ${f.front.service}`,
        "",
        "",
      ].join("\r\n")
    let text = ""
    socket.once("connect", () => {
      socket.write(
        head([
          "POST /capabilities/v1/providers/anthropic/v1/messages HTTP/1.1",
          `authorization: Bearer ${token}`,
          "content-type: application/json",
          "anthropic-version: 2023-06-01",
          "anthropic-beta: oauth-2025-04-20",
          `content-length: ${Buffer.byteLength(body)}`,
        ]),
      )
      socket.write(body)
      socket.write(head(["GET /capabilities/v1/challenge?lease=lease HTTP/1.1"]))
    })
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1")
      const lines = text.match(/^HTTP\/1\.1 \d+ [^\r]*/gm) ?? []
      // The challenge's answer is whole once its JSON closes.
      if (lines.length === 2 && text.endsWith("}\r\n0\r\n\r\n")) {
        socket.destroy()
        resolve(lines)
      }
    })
    socket.setTimeout(10000, () => {
      socket.destroy()
      reject(new Error(`no second answer within 10 s after: ${text.slice(0, 200)}`))
    })
    socket.once("error", reject)
    socket.once("close", () => reject(new Error(`connection ended after: ${text.slice(0, 200)}`)))
  })

test("[process] after the refusal of a 2 MiB messages body, its connection carries the next request to its answer", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const { token } = await opened(gateway)
    expect(await twoOnOneConnection(f, token, messagesOfSize(2 * modelBodyLimit))).toEqual([
      "HTTP/1.1 403 Forbidden",
      "HTTP/1.1 200 OK",
    ])
    expect(f.upstreamRequests()).toEqual([])
    expect(await ended(gateway)).toBe(false)
  })
}, 60000)

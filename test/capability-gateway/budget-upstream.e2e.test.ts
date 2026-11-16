import { expect, test } from "bun:test"
import { createServer, type Server, type Socket } from "node:net"
import { client, gateways, usageStream, type Fixture, type Gateway } from "./gateway-process"
import {
  answered,
  eventually,
  openReservations,
  runToken,
  small,
  usage,
  withBudget,
} from "./budget-fixture"

/** A TCP server on loopback whose connections `onConnection` drives. */
async function tcpServer(onConnection: (socket: Socket) => void) {
  const server = createServer(onConnection)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no TCP port")
  return { server, port: address.port }
}

const closed = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** A model upstream at `upstreamUrl` in place of the fixture's, for the gateway that `start` runs. */
const reaching = (start: (f: Fixture) => Promise<Gateway>, upstreamUrl: string) => (f: Fixture) =>
  start({ ...f, upstreamUrl })

/** The status of each of `count` model calls of 300 output tokens, each read to its end. */
async function calls(gateway: Gateway, count: number) {
  const token = await runToken(gateway)
  const statuses: number[] = []
  for (let call = 0; call < count; call++)
    statuses.push((await answered(client(gateway).call(token, 300))).status)
  return statuses
}

for (const [mode, start] of gateways) {
  test(`[${mode}] a call whose upstream connection is refused counts as a call and charges no output tokens, so retries do not spend the run`, async () => {
    // A port that was free a moment ago and on which nothing listens now.
    const { server, port } = await tcpServer((socket) => socket.destroy())
    await closed(server)
    await withBudget(reaching(start, `http://127.0.0.1:${port}`), small, async (f, gateway) => {
      // Four calls of 300 would pass 1000 if each were charged its max_tokens.
      expect(await calls(gateway, 4)).toEqual([503, 503, 503, 503])
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({ calls: 4, outputTokens: 0, spent: false })
    })
  }, 30000)

  test(`[${mode}] a call whose upstream connection ends after the request reached it is charged its max_tokens`, async () => {
    const requests: string[] = []
    const { server, port } = await tcpServer((socket) => {
      let read = ""
      socket.on("data", (bytes) => {
        read += bytes.toString("utf8")
        const head = read.indexOf("\r\n\r\n")
        const length = /\r\ncontent-length: *(\d+)/i.exec(read.slice(0, head))
        if (head < 0 || !length || read.length - head - 4 < Number(length[1])) return
        requests.push(read.slice(head + 4))
        socket.destroy()
      })
    })
    try {
      await withBudget(reaching(start, `http://127.0.0.1:${port}`), small, async (f, gateway) => {
        expect(await calls(gateway, 1)).toEqual([503])
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((body) => body.includes('"max_tokens":300'))).toBe(true)
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 300, spent: false })
      })
    } finally {
      await closed(server)
    }
  }, 30000)

  test(`[${mode}] a redirect of the provider counts as a call and charges no output tokens`, async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://127.0.0.1:9/v1/messages" },
        }),
    })
    try {
      await withBudget(reaching(start, upstream.url.origin), small, async (f, gateway) => {
        expect(await calls(gateway, 4)).toEqual([503, 503, 503, 503])
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 4, outputTokens: 0, spent: false })
      })
    } finally {
      await upstream.stop(true)
    }
  }, 30000)

  test(`[${mode}] an answer with a content-encoding is charged its max_tokens`, async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(Bun.gzipSync(usageStream({ output_tokens: 1 }, { output_tokens: 5 })), {
          headers: { "content-type": "text/event-stream", "content-encoding": "gzip" },
        }),
    })
    try {
      await withBudget(reaching(start, upstream.url.origin), small, async (f, gateway) => {
        expect(await calls(gateway, 1)).toEqual([503])
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 300, spent: false })
      })
    } finally {
      await upstream.stop(true)
    }
  }, 30000)

  test(`[${mode}] a body that names max_tokens twice is checked and sent with its last value, once`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      const body = (first: number, last: number) =>
        `{"model":"fixture-model","stream":true,"messages":[],"max_tokens":${first},"max_tokens":${last}}`
      // 200 is within the cap of 400; 1000 is not.
      expect((await answered(runner.provider(token, body(1000, 200)))).status).toBe(200)
      expect(await answered(runner.provider(token, body(200, 1000)))).toEqual({
        status: 403,
        text: "",
      })
      expect(f.upstreamRequests().map((request) => request.body)).toEqual([
        '{"model":"fixture-model","stream":true,"messages":[],"max_tokens":200}',
      ])
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 1 })
    })
  }, 30000)

  test(`[${mode}] a stream that ends with an error event of the provider, with no message_delta, is charged its max_tokens`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      const stream =
        usageStream({ input_tokens: 12, output_tokens: 1 }, null) +
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`
      f.setAnswerText(stream)
      const token = await runToken(gateway)
      expect(await answered(client(gateway).call(token, 300))).toEqual({
        status: 200,
        text: stream,
      })
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({ calls: 1, inputTokens: 12, outputTokens: 300 })
    })
  }, 30000)
}

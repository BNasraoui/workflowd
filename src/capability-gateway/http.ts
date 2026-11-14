import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Socket } from "node:net"

/** Preserve incomplete responses as connection failures, including on Bun 1.3.14. */
export function capabilityHttpServer(handle: (request: Request) => Promise<Response>) {
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const server = createServer({ maxHeaderSize: 8192 }, (incoming, outgoing) => {
    const lifetime = new AbortController()
    const abort = () => lifetime.abort()
    incoming.socket.once("close", abort)
    const work = (async () => {
      try {
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
        // These are the local relay's HTTP/1 framing, not agent capability headers.
        headers.delete("connection")
        headers.delete("transfer-encoding")
        const request = new Request(`http://capability.invalid${incoming.url}`, {
          method: incoming.method ?? "GET",
          headers,
          body: ["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? null
            : Readable.toWeb(incoming),
          duplex: "half",
          signal: lifetime.signal,
        })
        const response = await handle(request)
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body) await pipeline(Readable.from(response.body), outgoing)
        else outgoing.end()
      } catch {
        // Sending a terminal chunk here would turn a revoked/partial response into success.
        outgoing.destroy()
      } finally {
        incoming.socket.removeListener("close", abort)
      }
    })()
    pending.add(work)
    void work.finally(() => pending.delete(work))
  })
  server.requestTimeout = 120000
  server.headersTimeout = 15000
  server.setTimeout(120000, (socket) => socket.destroy())
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  const close = async () => {
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
    for (const socket of sockets) socket.destroy()
    await Promise.all([stopped, ...pending])
  }
  return { server, close }
}

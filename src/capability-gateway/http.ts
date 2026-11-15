import { createServer, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Socket } from "node:net"
import { Cause, Effect, Exit } from "effect"
import { readRequestBody } from "./claude"
import { CapabilityRefused } from "./store"
import type { CapabilityGateway } from "./service"

const noStore = { headers: { "cache-control": "no-store" } }
// A refusal is final for this proof or lease; anything else (store, keys, mint) may be retried.
const refusedOr = (exit: Exit.Exit<unknown, unknown>) =>
  new Response(null, {
    status:
      Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && reason.error instanceof CapabilityRefused,
      )
        ? 403
        : 503,
  })

/**
 * The gateway's API. A runner gets a challenge for its lease and posts its OIDC proof for that
 * challenge; every other route is a run's call and carries its run token. A challenge or session
 * runs to its end whether or not the client is still there: a lost answer costs the runner a new
 * challenge and proof, never the run.
 */
export const capabilityApi =
  (gateway: typeof CapabilityGateway.Service) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/capabilities/v1/challenge") {
      const lease = url.searchParams.get("lease")
      if (request.method !== "GET" || lease === null || [...url.searchParams].length !== 1)
        return new Response(null, { status: 403 })
      const exit = await Effect.runPromiseExit(gateway.sessionChallenge(lease))
      return Exit.isSuccess(exit) ? Response.json(exit.value, noStore) : refusedOr(exit)
    }
    if (url.pathname === "/capabilities/v1/session") {
      if (
        request.method !== "POST" ||
        url.search !== "" ||
        request.headers.get("content-type") !== "application/json"
      )
        return new Response(null, { status: 403 })
      const proof = await readRequestBody(
        request,
        AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        20000,
      )
        .then((body): unknown => JSON.parse(body.toString("utf8")))
        .catch(() => undefined)
      if (proof === undefined) return new Response(null, { status: 403 })
      const exit = await Effect.runPromiseExit(gateway.session(proof))
      return Exit.isSuccess(exit) ? Response.json(exit.value, noStore) : refusedOr(exit)
    }
    return Effect.runPromise(gateway.handle(request), { signal: request.signal })
  }

/** Preserve incomplete responses as connection failures, including on Bun 1.3.14. */
export function capabilityHttpServer(
  handle: (request: Request) => Promise<Response>,
  /** On the gateway's network listener, Host names the listener, not the capability origin. */
  network = false,
) {
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const responses = new Set<ServerResponse>()
  const server = createServer({ maxHeaderSize: 8192 }, (incoming, outgoing) => {
    responses.add(outgoing)
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
        if (network) headers.delete("host")
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
    void work.finally(() => {
      pending.delete(work)
      responses.delete(outgoing)
    })
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
    // A client that left may never be reported (Bun 1.3.14); its unfinished answer ends here.
    for (const response of responses) response.destroy()
    await Promise.all([stopped, ...pending])
  }
  return { server, close }
}

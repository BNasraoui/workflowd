import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { PassThrough, Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  BlockList,
  createConnection,
  createServer as createNetServer,
  isIP,
  type Socket,
} from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { readRequestBody } from "./claude"
import { capabilityOrigin } from "./headers"
import {
  maxHeaderBytes,
  maxRelaySockets,
  maxStreamIdleMs,
} from "../../deploy/sandbox/capability-limits.mjs"
import { CapabilityRefused } from "./store"
import { maxMints, type CapabilityGateway } from "./service"
import { peerCredentials, serveSocket } from "../peer-socket"
import type { CapabilityGatewayConfig } from "../sandbox/config"

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

/**
 * The headers of the front, Tailscale Serve, on each request that it passes on from a runner (a
 * tagged node). Serve sets `set`, each once, in place of any copy from the client:
 * `X-Forwarded-For` is the runner's tailnet address, `X-Forwarded-Proto` is `https`, and
 * `X-Forwarded-Host` is the Host that the runner sent, the Service's name. A request with a
 * header of `refused`, or with a name that starts with one of `refusedPrefixes` and is not in
 * `set`, did not come from Serve for a tagged node: Serve sets no `Tailscale-` header for one,
 * and passes the others on from the client.
 */
export const frontHeaders = {
  set: ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"],
  refused: ["forwarded", "x-real-ip", "via"],
  refusedPrefixes: ["x-forwarded-", "tailscale-"],
} as const

const tailnetIpv4 = new BlockList()
tailnetIpv4.addSubnet("100.64.0.0", 10, "ipv4")
const tailnetIpv6 = new BlockList()
tailnetIpv6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6")

/**
 * The runner's tailnet address when `rawHeaders` (name, value, name, value...) are those of the
 * front for `service`: each header of `frontHeaders.set` exactly once, the proto `https`, the host
 * `service`, and one tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48) as `X-Forwarded-For`;
 * and no refused header. Undefined otherwise.
 */
function frontPeer(rawHeaders: ReadonlyArray<string>, service: string) {
  const values = new Map<string, Array<string>>()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase()
    if ((frontHeaders.set as ReadonlyArray<string>).includes(name))
      values.set(name, [...(values.get(name) ?? []), rawHeaders[index + 1]!])
    else if (
      (frontHeaders.refused as ReadonlyArray<string>).includes(name) ||
      frontHeaders.refusedPrefixes.some((prefix) => name.startsWith(prefix))
    )
      return undefined
  }
  const one = (name: string) => {
    const all = values.get(name)
    return all?.length === 1 ? all[0] : undefined
  }
  const address = one("x-forwarded-for") ?? ""
  const family = isIP(address)
  return one("x-forwarded-proto") === "https" &&
    one("x-forwarded-host") === service &&
    ((family === 4 && tailnetIpv4.check(address, "ipv4")) ||
      (family === 6 && tailnetIpv6.check(address, "ipv6")))
    ? address
    : undefined
}

/**
 * The most requests of one runner, by its tailnet address, that the listener serves at once: as
 * many as the run's relay sends at once (`maxRelaySockets`), as the runner's helper opens the
 * session before the relay starts. Serve sends one request at a time on each of its connections
 * to the gateway, so this bounds the connections that one runner holds.
 */
export const maxPeerRequests = maxRelaySockets

/**
 * The most connections that the listener holds at once for a gateway that admits `maxStreams`
 * streams: one for each stream; one for each run token mint that runs at once (`maxMints`), each
 * the session or renewal that waits on it; and one runner's whole share (`maxPeerRequests`), so
 * that a runner at its own bound leaves those of the streams and mints to the other runs. Each
 * other request waits on no stream and no mint: it is answered at once, or within the 10 s bound
 * of its body or of the job keys.
 */
export const maxListenerConnections = (maxStreams: number) =>
  maxStreams + maxMints + maxPeerRequests

/** The open requests of each runner: `take` refuses one above `maxPeerRequests`. */
function peerRequests() {
  const open = new Map<string, number>()
  return {
    take: (peer: string) => {
      const held = open.get(peer) ?? 0
      if (held >= maxPeerRequests) return false
      open.set(peer, held + 1)
      return true
    },
    release: (peer: string) => {
      const held = (open.get(peer) ?? 1) - 1
      if (held === 0) open.delete(peer)
      else open.set(peer, held)
    },
  }
}

/**
 * The body of `incoming` as a web stream. A route that cancels the stream, as one does a body
 * above its bound, ends only its own reading: the rest of the body is read and dropped, as for a
 * body that no route reads, so the route's answer is sent and the connection carries the next
 * request. `incoming` itself is not destroyed: in Bun that aborts the answer and the connection
 * before the route's refusal is sent. An error of `incoming` ends the stream with that error.
 */
function requestBody(incoming: IncomingMessage) {
  const body = new PassThrough()
  incoming.on("error", (error) => body.destroy(error))
  body.once("close", () => {
    if (incoming.readableEnded) return
    incoming.unpipe(body)
    incoming.resume()
  })
  incoming.pipe(body)
  return Readable.toWeb(body)
}

/**
 * The gateway's HTTP server, behind the gate of `serveCapabilityListener`. A request without the
 * front's headers for `service` (`frontPeer`) gets an empty 403 and reaches no route. A runner's
 * request above `maxPeerRequests` is refused as the gate refuses a connection: its connection
 * ends at once, with no answer. Each other request reaches `handle` at the capability origin,
 * without the front's three headers and with no Host header: Host names this listener, not a
 * capability. An incomplete response stays a connection failure, including on Bun 1.3.14.
 */
function capabilityHttpServer(handle: (request: Request) => Promise<Response>, service: string) {
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const responses = new Set<ServerResponse>()
  const peers = peerRequests()
  const server = createServer({ maxHeaderSize: maxHeaderBytes }, (incoming, outgoing) => {
    // The request's connection, taken once: Bun clears `incoming.socket` when the request ends.
    const socket = incoming.socket
    const peer = frontPeer(incoming.rawHeaders, service)
    if (peer !== undefined && !peers.take(peer)) return void socket.destroy()
    responses.add(outgoing)
    const lifetime = new AbortController()
    const abort = () => lifetime.abort()
    socket.once("close", abort)
    const work = (async () => {
      try {
        if (peer === undefined) {
          outgoing.writeHead(403)
          outgoing.end()
          return
        }
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
        // These are the relay's HTTP/1 framing and the listener's address, not capability headers.
        headers.delete("connection")
        headers.delete("transfer-encoding")
        headers.delete("host")
        for (const name of frontHeaders.set) headers.delete(name)
        const request = new Request(`${capabilityOrigin}${incoming.url}`, {
          method: incoming.method ?? "GET",
          headers,
          body: ["GET", "HEAD"].includes(incoming.method ?? "GET") ? null : requestBody(incoming),
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
        socket.removeListener("close", abort)
      }
    })()
    pending.add(work)
    void work.finally(() => {
      pending.delete(work)
      responses.delete(outgoing)
      if (peer !== undefined) peers.release(peer)
    })
  })
  server.requestTimeout = 120000
  server.headersTimeout = 15000
  // A socket idle this long is destroyed, also under a silent model stream: the stream's idle
  // limit in the config is bounded by the same number.
  server.setTimeout(maxStreamIdleMs, (socket) => socket.destroy())
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  // Ends each connection and answer, once the server no longer accepts; the server's own close
  // is the socket's (`serveSocket`).
  const finish = async () => {
    for (const socket of sockets) socket.destroy()
    // A client that left may never be reported (Bun 1.3.14); its unfinished answer ends here.
    for (const response of responses) response.destroy()
    await Promise.all(pending)
  }
  return { server, finish }
}

/**
 * The gateway's one listener: the Unix socket `listen.socket`, which only its front, Tailscale
 * Serve, reaches. The gateway owns the socket's directory, mode 0710 with the front's group, and
 * the socket has mode 0660. On each connection the gate reads the caller's uid from the kernel
 * (SO_PEERCRED) as it accepts it, before it reads a byte: a caller whose uid is not the front's is
 * ended there, and no route runs. Each other connection goes on to the HTTP server, which listens
 * on a socket in a new directory of the gateway's own below the temporary directory, mode 0700,
 * that only the gateway's uid enters: Bun's HTTP server gives no descriptor of a connection that
 * it accepts, and serves no socket that another server accepted, so the uid is read here. The gate
 * holds at most `maxListenerConnections(maxStreams)` connections at once; it ends each one above
 * that as it accepts it, and queues none.
 * Resolves to the close of both, which removes that directory.
 */
export async function serveCapabilityListener(
  listen: CapabilityGatewayConfig["listen"],
  maxStreams: number,
  handle: (request: Request) => Promise<Response>,
) {
  const { server, finish } = capabilityHttpServer(handle, listen.service)
  const directory = await mkdtemp(join(tmpdir(), "workflowd-gateway-"))
  const inner = join(directory, "http.sock")
  const connections = new Set<Socket>()
  const maxConnections = maxListenerConnections(maxStreams)
  const gate = createNetServer((caller) => {
    caller.on("error", () => caller.destroy())
    if (peerCredentials(caller)?.uid !== listen.front.uid) return caller.destroy()
    if (connections.size >= maxConnections) return caller.destroy()
    connections.add(caller)
    const onward = createConnection(inner)
    onward.on("error", () => onward.destroy())
    caller.once("close", () => {
      connections.delete(caller)
      onward.destroy()
    })
    onward.once("close", () => caller.destroy())
    caller.pipe(onward)
    onward.pipe(caller)
  })
  const stops: Array<() => Promise<void>> = []
  const close = async () => {
    for (const caller of connections) caller.destroy()
    await Promise.all([...stops.map((stop) => stop()), finish()])
    await rm(directory, { recursive: true, force: true })
  }
  try {
    stops.push(
      await serveSocket(server, inner, process.getgid!(), 0o700, {
        socket: "capability listener's private socket",
        group: "the gateway's group",
      }),
    )
    stops.push(
      await serveSocket(gate, listen.socket, listen.front.gid, 0o710, {
        socket: "capability listener",
        group: "the front's group",
      }),
    )
  } catch (error) {
    await close()
    throw error
  }
  return close
}

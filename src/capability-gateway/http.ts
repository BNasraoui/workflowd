import { createServer, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
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
import { runRoutePrefix } from "./run-routes"
import { maxHeaderBytes, maxStreamIdleMs } from "../../deploy/sandbox/capability-limits.mjs"
import { CapabilityRefused } from "./store"
import type { CapabilityGateway } from "./service"
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
 * True when `rawHeaders` (name, value, name, value...) are those of the front for `service`: each
 * header of `frontHeaders.set` exactly once, the proto `https`, the host `service`, and one tailnet
 * address (100.64.0.0/10 or fd7a:115c:a1e0::/48) as `X-Forwarded-For`; and no refused header.
 */
export function fromFront(rawHeaders: ReadonlyArray<string>, service: string) {
  const values = new Map<string, Array<string>>()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase()
    if ((frontHeaders.set as ReadonlyArray<string>).includes(name))
      values.set(name, [...(values.get(name) ?? []), rawHeaders[index + 1]!])
    else if (
      (frontHeaders.refused as ReadonlyArray<string>).includes(name) ||
      frontHeaders.refusedPrefixes.some((prefix) => name.startsWith(prefix))
    )
      return false
  }
  const one = (name: string) => {
    const all = values.get(name)
    return all?.length === 1 ? all[0] : undefined
  }
  const address = one("x-forwarded-for") ?? ""
  const family = isIP(address)
  return (
    one("x-forwarded-proto") === "https" &&
    one("x-forwarded-host") === service &&
    ((family === 4 && tailnetIpv4.check(address, "ipv4")) ||
      (family === 6 && tailnetIpv6.check(address, "ipv6")))
  )
}

/**
 * The gateway's HTTP server, behind the gate of `serveCapabilityListener`. A request without the
 * front's headers for `service` (`fromFront`) gets an empty 403 and reaches no route. Each other
 * request reaches `handle` at the capability origin, without the front's three headers and with
 * no Host header: Host names this listener, not a capability. An incomplete response stays a
 * connection failure, including on Bun 1.3.14.
 */
function capabilityHttpServer(handle: (request: Request) => Promise<Response>, service: string) {
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const responses = new Set<ServerResponse>()
  const server = createServer({ maxHeaderSize: maxHeaderBytes }, (incoming, outgoing) => {
    responses.add(outgoing)
    const lifetime = new AbortController()
    const abort = () => lifetime.abort()
    incoming.socket.once("close", abort)
    const work = (async () => {
      try {
        if (!fromFront(incoming.rawHeaders, service)) {
          outgoing.writeHead(403)
          outgoing.end()
          return
        }
        // A run route is matched on its path as the runner sent it: a path that a URL parser
        // would change (dot segments, a backslash) and that would then name a run route is
        // refused, so no route is reached by a path that differs from its own.
        const parsed = new URL(`${capabilityOrigin}${incoming.url ?? ""}`)
        if (
          parsed.pathname.startsWith(runRoutePrefix) &&
          `${parsed.pathname}${parsed.search}` !== incoming.url
        ) {
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
 * it accepts, and serves no socket that another server accepted, so the uid is read here.
 * Resolves to the close of both, which removes that directory.
 */
export async function serveCapabilityListener(
  listen: CapabilityGatewayConfig["listen"],
  handle: (request: Request) => Promise<Response>,
) {
  const { server, finish } = capabilityHttpServer(handle, listen.service)
  const directory = await mkdtemp(join(tmpdir(), "workflowd-gateway-"))
  const inner = join(directory, "http.sock")
  const connections = new Set<Socket>()
  const gate = createNetServer((caller) => {
    caller.on("error", () => caller.destroy())
    if (peerCredentials(caller)?.uid !== listen.front.uid) return caller.destroy()
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

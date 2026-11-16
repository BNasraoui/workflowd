import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as httpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { pipeline } from "node:stream"

/** The bound port of a listening TCP server. */
export function portOf(server: { address(): string | AddressInfo | null }) {
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listener unavailable")
  return address.port
}

/** A self-signed certificate for 127.0.0.1 under `root`: the TLS of the gateway's front. */
export async function loopbackCertificate(root: string) {
  const key = join(root, "tls.key")
  const cert = join(root, "tls.pem")
  const child = Bun.spawn(
    [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  )
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
  return { key, cert }
}

/** The runner's tailnet address, which the front names as the source of each request. */
export const runnerAddress = "100.64.0.7"

/** Each header name of a request, with each of its values, in order. */
type HeaderValues = Record<string, Array<string>>

/**
 * The headers that Tailscale Serve (v1.102.3) sends to a `unix:` target of a Service for a
 * request of a tagged node: Go's reverse proxy drops the hop-by-hop headers, `Forwarded` and the
 * client's `X-Forwarded-For`, `-Host` and `-Proto`; Serve drops the client's identity headers,
 * sets `Host` to `localhost`, `X-Forwarded-Host` to the Host that the client sent,
 * `X-Forwarded-Proto` to `https` and `X-Forwarded-For` to the client's tailnet address, and
 * passes each other header on.
 */
function serveHeaders(rawHeaders: ReadonlyArray<string>) {
  const values: HeaderValues = {}
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase()
    ;(values[name] ??= []).push(rawHeaders[index + 1]!)
  }
  const host = values.host?.[0] ?? ""
  const named = (values.connection ?? []).flatMap((value) =>
    value.split(",").map((name) => name.trim().toLowerCase()),
  )
  for (const name of [
    ...named,
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-user-profile-pic",
    "tailscale-funnel-request",
    "tailscale-headers-info",
    "tailscale-app-capabilities",
    "host",
  ])
    delete values[name]
  values.host = ["localhost"]
  values["x-forwarded-host"] = [host]
  values["x-forwarded-proto"] = ["https"]
  values["x-forwarded-for"] = [runnerAddress]
  return values
}

/** What a test changes in the front: see `tlsFront`. */
export interface FrontHooks {
  readonly lost?: (path: string | undefined, status: number | undefined) => boolean
  readonly held?: (path: string | undefined) => Promise<void> | undefined
  readonly alter?: (headers: HeaderValues) => HeaderValues
}

/**
 * The gateway's front, as Tailscale Serve is in production: it ends TLS with `tls` on a loopback
 * port and passes each request on to the gateway's Unix socket `socket`, with the headers that
 * Serve sends (`serveHeaders`). A runner reaches the gateway at `origin`, trusting `ca`; the
 * Service's name, as Serve sends it on, is `service`. `hooks` changes the front for a test, also
 * after its start: when `lost(path, status)` holds for a gateway answer, the gateway has sent it
 * and the client never gets it, as the front closes the connection instead; a request reaches the
 * gateway once `held(path)` settles; `alter` changes the headers that the front sends, as a front
 * other than Serve would.
 */
export async function tlsFront(
  tls: { key: string; cert: string },
  socket: string,
  hooks: FrontHooks = {},
) {
  let current = hooks
  const server = httpsServer(
    { key: await readFile(tls.key), cert: await readFile(tls.cert) },
    (incoming, outgoing) => void forward(incoming, outgoing),
  )
  const forward = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const { lost = () => false, held = () => undefined, alter = (headers) => headers } = current
    await held(incoming.url)
    const headers = Object.entries(alter(serveHeaders(incoming.rawHeaders))).map(
      ([name, values]) => [name, values.length === 1 ? values[0]! : values] as const,
    )
    const upstream = httpRequest(
      {
        socketPath: socket,
        path: incoming.url,
        method: incoming.method,
        headers: Object.fromEntries(headers),
      },
      (reply) => {
        if (lost(incoming.url, reply.statusCode)) {
          reply.resume()
          reply.once("end", () => incoming.socket.destroy())
          return
        }
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers)
        pipeline(reply, outgoing, () => {})
      },
    )
    // Serve answers 502 when the gateway gives no answer; an answer cut midway stays cut.
    upstream.once("error", () => {
      if (outgoing.headersSent) return outgoing.destroy()
      outgoing.writeHead(502)
      outgoing.end()
    })
    pipeline(incoming, upstream, () => {})
  }
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = portOf(server)
  return {
    port,
    origin: `https://127.0.0.1:${port}`,
    service: `127.0.0.1:${port}`,
    ca: await readFile(tls.cert, "utf8"),
    /** Replaces the front's hooks for the requests that come next. */
    hook: (next: FrontHooks) => {
      current = next
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}
export type Front = Awaited<ReturnType<typeof tlsFront>>

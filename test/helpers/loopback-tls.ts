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

/** A self-signed certificate for 127.0.0.1 under `root`: the gateway's TLS on loopback. */
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

/**
 * TLS with `tls` in front of the plain gateway at `gatewayPort`, as Tailscale Serve is in
 * production. When `lost(path, status)` holds for a gateway answer, the gateway has sent it and
 * the client never gets it: the front closes the connection instead. A request reaches the
 * gateway once `held(path)` settles.
 */
export async function tlsFront(
  tls: { key: string; cert: string },
  gatewayPort: number,
  lost: (path: string | undefined, status: number | undefined) => boolean = () => false,
  held: (path: string | undefined) => Promise<void> | undefined = () => undefined,
) {
  const server = httpsServer(
    { key: await readFile(tls.key), cert: await readFile(tls.cert) },
    (incoming, outgoing) => void forward(incoming, outgoing),
  )
  const forward = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    await held(incoming.url)
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
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
    upstream.once("error", () => outgoing.destroy())
    pipeline(incoming, upstream, () => {})
  }
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    port: portOf(server),
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

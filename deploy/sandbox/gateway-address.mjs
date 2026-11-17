import { execFile } from "node:child_process"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP } from "node:net"
import { Readable, pipeline } from "node:stream"

/**
 * The runner's lookup of the gateway's Service name. The runner joins the tailnet with
 * `--accept-dns=false` (tailscale.sh), so tailscaled does not point the runner's resolver at
 * MagicDNS, and the system resolver does not know a `*.ts.net` name. tailscaled still fills the
 * host table of its own resolver (100.100.100.100) from the netmap, as it does for each node:
 * `dnsConfigForNetmap` of ipn/ipnlocal/node_backend.go (v1.94.2) sets `Hosts` before it returns
 * for a node that does not accept the DNS settings. This module asks that resolver through
 * tailscaled's LocalAPI (`dns-query`, which needs root), with no change to the runner's DNS, and
 * gives each connection that address, with the name kept for TLS (SNI and the certificate) and
 * for the Host header.
 */

/** The LocalAPI socket of the tailscaled that tailscale.sh starts, at its default path. */
export const localApiSocket = "/var/run/tailscale/tailscaled.sock"

/** A gateway name that only tailscaled resolves: a MagicDNS name of the tailnet. */
const tailnetName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/

const tailnetAddresses = new BlockList()
tailnetAddresses.addSubnet("100.64.0.0", 10, "ipv4")

/** An error of the lookup, with the code of a name that does not resolve. */
const unresolved = () => Object.assign(new Error("gateway name unresolved"), { code: "ENOTFOUND" })

/**
 * The first IPv4 address of an A record in the DNS message `bytes`, when its answer code is 0
 * and the address is a tailnet address (100.64.0.0/10); undefined otherwise.
 */
export function dnsAnswerAddress(bytes) {
  try {
    if (bytes.length < 12 || (bytes.readUInt16BE(2) & 0x000f) !== 0) return undefined
    const questions = bytes.readUInt16BE(4)
    const answers = bytes.readUInt16BE(6)
    let offset = 12
    const skipName = () => {
      for (;;) {
        const length = bytes.readUInt8(offset)
        if ((length & 0xc0) === 0xc0) return void (offset += 2)
        offset += 1 + length
        if (length === 0) return
      }
    }
    for (let index = 0; index < questions; index++) {
      skipName()
      offset += 4
    }
    for (let index = 0; index < answers; index++) {
      skipName()
      const type = bytes.readUInt16BE(offset)
      const kind = bytes.readUInt16BE(offset + 2)
      const length = bytes.readUInt16BE(offset + 8)
      offset += 10
      if (type === 1 && kind === 1 && length === 4) {
        const address = [...bytes.subarray(offset, offset + 4)].join(".")
        if (offset + 4 <= bytes.length && tailnetAddresses.check(address, "ipv4")) return address
      }
      offset += length
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Asks tailscaled's LocalAPI for the A record of `name` and gives the DNS message of its answer.
 * The LocalAPI answers `dns-query` only to root: the runner's own sudo runs curl on the socket.
 */
export function localDnsQuery(name, run = execFile) {
  const query = new URLSearchParams({ name, type: "A" })
  return new Promise((resolve, reject) =>
    run(
      "/usr/bin/sudo",
      [
        "-n", "/usr/bin/curl", "--silent", "--show-error", "--fail", "--max-time", "10",
        "--unix-socket", localApiSocket,
        `http://local-tailscaled.sock/localapi/v0/dns-query?${query}`,
      ],
      { encoding: "utf8", maxBuffer: 65536, timeout: 15000 },
      (error, stdout) => {
        if (error) return reject(unresolved())
        try {
          const answer = JSON.parse(stdout)
          if (typeof answer?.Bytes !== "string") return reject(unresolved())
          resolve(Buffer.from(answer.Bytes, "base64"))
        } catch {
          reject(unresolved())
        }
      },
    ),
  )
}

/**
 * The tailnet address of the MagicDNS name `name`, from tailscaled's resolver. The netmap can
 * reach tailscaled some seconds after it joined, so a name that has no answer yet is asked again,
 * `tries` times in all, `pauseMs` apart.
 */
export async function serviceAddress(
  name,
  { query = localDnsQuery, tries = 10, pauseMs = 2000, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {},
) {
  if (!tailnetName.test(name)) throw unresolved()
  for (let attempt = 1; ; attempt++) {
    const address = await query(name).then(dnsAnswerAddress, () => undefined)
    if (address !== undefined) return address
    if (attempt >= tries) throw unresolved()
    await sleep(pauseMs)
  }
}

/**
 * A lookup of net.connect that gives `address` for `name` alone; any other name does not
 * resolve. It answers both forms of Node's lookup: one address, and a list of them.
 */
export function pinnedLookup(name, address) {
  const family = isIP(address)
  return (hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback
    if (hostname !== name) return done(unresolved())
    if (typeof options === "object" && options?.all) return done(null, [{ address, family }])
    return done(null, address, family)
  }
}

/** Statuses whose answer has no body. */
const bodiless = new Set([204, 205, 304])

/**
 * The fetch of the runner's calls to the gateway: an HTTPS request whose connection goes to
 * `address` for `name`, with the name kept for TLS and the Host header. It takes what the
 * runner's calls use: a method, headers, a body (bytes or a stream), and a signal, whose reason
 * ends the request as fetch's does. A redirect is answered as it is; nothing follows it.
 */
export function pinnedFetch(name, address, agent) {
  const lookup = pinnedLookup(name, address)
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const signal = init.signal
      if (signal?.aborted) return reject(signal.reason)
      const request = httpsRequest(
        new URL(String(input)),
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers ?? {})),
          lookup,
          ...(agent ? { agent } : {}),
        },
        (reply) => {
          const status = reply.statusCode ?? 0
          const headers = new Headers()
          for (const [key, value] of Object.entries(reply.headers))
            for (const each of [value].flat()) if (each !== undefined) headers.append(key, each)
          const empty = bodiless.has(status) || init.method === "HEAD"
          if (empty) reply.resume()
          resolve(new Response(empty ? null : Readable.toWeb(reply), { status, headers }))
        },
      )
      const abort = () => request.destroy(signal.reason)
      signal?.addEventListener("abort", abort, { once: true })
      request.once("close", () => signal?.removeEventListener("abort", abort))
      request.once("error", reject)
      const body = init.body
      if (body === undefined || body === null) request.end()
      else if (body instanceof ReadableStream)
        pipeline(Readable.fromWeb(body), request, (error) => {
          if (error) request.destroy(error)
        })
      else request.end(typeof body === "string" ? body : Buffer.from(body))
    })
}

/**
 * How the runner reaches the gateway at `gateway`: for a MagicDNS name, its fetch and its lookup
 * with the address that tailscaled gives, and that address; for any other host (an address, a
 * test's name), the runtime's fetch and resolver.
 */
export async function gatewayTransport(gateway, options = {}) {
  const name = new URL(gateway).hostname
  if (!tailnetName.test(name)) return { send: fetch, lookup: undefined, address: undefined }
  const address = await serviceAddress(name, options)
  return { send: pinnedFetch(name, address), lookup: pinnedLookup(name, address), address }
}

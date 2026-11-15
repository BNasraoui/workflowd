import { createServer as httpServer } from "node:http"
import { Agent, request as httpsRequest } from "node:https"
import { pipeline } from "node:stream"
import { writeFileSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { gatewayOrigin } from "./bootstrap-helper.mjs"
import { renewalRequests } from "./renewal.mjs"
import { maxHeaderBytes, maxStreamsPerRun } from "./capability-limits.mjs"

const root = "/run/workflowd-sandbox"

function gitReadRoute(method, target) {
  return (
    (method === "GET" &&
      /^\/capabilities\/v1\/git\/[1-9][0-9]{0,15}\.git\/info\/refs\?service=git-upload-pack$/.test(
        target ?? "",
      )) ||
    (method === "POST" &&
      /^\/capabilities\/v1\/git\/[1-9][0-9]{0,15}\.git\/git-upload-pack$/.test(target ?? ""))
  )
}

async function configInput() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 16384) throw new Error("relay configuration refused")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

/** The local half of a run's calls: it adds the run token and forwards to the gateway over HTTPS. */
export async function serveRunnerRelay(config, directory = root) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(config.token) ||
    !Number.isSafeInteger(config.expiresAt) ||
    !Number.isSafeInteger(config.renewAt) ||
    !Number.isSafeInteger(config.deadline) ||
    config.expiresAt > config.deadline
  )
    throw new Error("relay configuration refused")
  const origin = gatewayOrigin(config.gateway)
  const agent = new Agent({ keepAlive: true, maxSockets: 8 })
  let credential = config
  let renewal
  let streams = 0
  let closed = false
  const sockets = new Set()
  const http = httpServer(
    { maxHeaderSize: maxHeaderBytes, requestTimeout: 120000, headersTimeout: 10000 },
    (request, response) => {
      if (closed || streams >= maxStreamsPerRun || Date.now() >= credential.expiresAt) {
        response.writeHead(503, { "retry-after": "5" })
        response.end()
        return
      }
      if (
        !(
          gitReadRoute(request.method, request.url) ||
          (request.method === "POST" &&
            /^\/v1\/messages(?:\/count_tokens)?(?:\?beta=true)?$/.test(request.url ?? ""))
        ) ||
        request.headers.authorization !== "Bearer workflowd-local" ||
        request.headers["x-api-key"] !== undefined ||
        ["keep-alive", "proxy-authorization", "proxy-connection", "upgrade", "te", "trailer"].some(
          (name) => request.headers[name] !== undefined,
        ) ||
        (request.headers.connection !== undefined &&
          !/^(?:keep-alive|close)$/i.test(request.headers.connection)) ||
        request.rawHeaders
          .filter((_, i) => i % 2 === 0)
          .filter((name) => name.toLowerCase() === "authorization").length !== 1
      ) {
        response.writeHead(403)
        response.end()
        return
      }
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(
          ([key]) =>
            ![
              "host",
              "authorization",
              "connection",
              "transfer-encoding",
              "content-length",
            ].includes(key),
        ),
      )
      const path = request.url.startsWith("/capabilities/v1/")
        ? request.url
        : `/capabilities/v1/providers/anthropic${request.url}`
      streams++
      let counted = true
      const upstream = httpsRequest(
        new URL(path, origin),
        {
          method: request.method,
          headers: { ...headers, authorization: `Bearer ${credential.token}` },
          agent,
          maxHeaderSize: maxHeaderBytes,
        },
        (reply) => {
          const output = Object.fromEntries(
            Object.entries(reply.headers).filter(
              ([key]) => !["connection", "transfer-encoding", "keep-alive"].includes(key),
            ),
          )
          response.writeHead(reply.statusCode ?? 503, output)
          // An answer cut upstream stays cut here: no terminal chunk turns it into success.
          pipeline(reply, response, (error) => {
            if (error) upstream.destroy()
          })
        },
      )
      upstream.setTimeout(120000, () => upstream.destroy())
      upstream.once("close", () => {
        if (counted) streams--
        counted = false
        if (!response.writableEnded) response.destroy()
      })
      upstream.once("error", () => response.destroy())
      response.once("close", () => {
        if (!response.writableFinished) upstream.destroy()
      })
      pipeline(request, upstream, (error) => {
        if (error) upstream.destroy()
      })
    },
  )
  http.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  let failures = 0
  const renew = async () => {
    let retryable = true
    // After a clock jump the predecessor may have expired: it is never sent.
    if (Date.now() >= credential.expiresAt) {
      end("expiry")
      return
    }
    try {
      const { status, raw } = await new Promise((resolve, reject) => {
        const call = httpsRequest(
          new URL("/capabilities/v1/renew", origin),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${credential.token}`,
              "content-type": "application/json",
              "content-length": "2",
            },
            agent,
            timeout: 10000,
          },
          (reply) => {
            let text = ""
            reply.on("data", (bytes) => {
              text += bytes.toString()
              if (text.length > 4096) reply.destroy(new Error("renewal refused"))
            })
            reply.once("end", () => resolve({ status: reply.statusCode, raw: text }))
            reply.once("error", reject)
          },
        )
        call.once("timeout", () => call.destroy(new Error("renewal unavailable")))
        call.once("error", reject)
        call.end("{}")
      })
      retryable = status === 429 || status === 503
      if (status !== 200) throw new Error("renewal unavailable")
      const next = JSON.parse(raw)
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(next.token) ||
        !Number.isSafeInteger(next.expiresAt) ||
        !Number.isSafeInteger(next.renewAt) ||
        next.expiresAt > config.deadline ||
        next.expiresAt <= Date.now() ||
        next.renewAt <= Date.now()
      )
        throw new Error("renewal refused")
      credential = next
      failures = 0
      clearTimeout(expiry)
      expiry = setTimeout(() => end("expiry"), next.expiresAt - Date.now())
      renewal = setTimeout(renew, next.renewAt - Date.now())
    } catch {
      if (closed) return
      // Retry only renewal of the same predecessor, never inference, and never more often than
      // the gateway permits. A refusal, or the last permitted request failing, ends the session.
      failures++
      const remaining = credential.expiresAt - Date.now()
      const delay = Math.min(30000, 1000 * 2 ** (failures - 1))
      const jittered = delay + Math.floor((Math.random() * delay) / 4)
      if (!retryable || failures >= renewalRequests || jittered >= remaining) {
        end("renewal")
        return
      }
      renewal = setTimeout(renew, jittered)
    }
  }
  renewal = setTimeout(renew, Math.max(0, credential.renewAt - Date.now()))
  const deadline = setTimeout(() => end("deadline"), Math.max(0, config.deadline - Date.now()))
  let expiry = setTimeout(() => end("expiry"), Math.max(0, config.expiresAt - Date.now()))
  /** Ends the session and leaves its fixed reason for the job's hold step. */
  function end(reason) {
    if (closed) return
    try {
      writeFileSync(`${directory}/relay-ended`, `${reason}\n`, { mode: 0o600 })
    } catch {
      // The hold still sees the relay end; only the reason is lost.
    }
    stop()
  }
  function stop() {
    if (closed) return
    closed = true
    clearTimeout(deadline)
    clearTimeout(expiry)
    clearTimeout(renewal)
    for (const socket of sockets) socket.destroy()
    agent.destroy()
    http.close()
  }
  await new Promise((resolve, reject) => {
    http.once("error", reject)
    http.listen(`${directory}/gateway.sock`, resolve)
  })
  await chmod(`${directory}/gateway.sock`, 0o600)
  return { close: stop }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] !== "runner") throw new Error("relay operation refused")
    const relay = await serveRunnerRelay(await configInput(), process.argv[3] ?? root)
    process.stdout.write("ready\n")
    process.once("SIGTERM", relay.close)
  } catch {
    process.stderr.write("capability relay unavailable\n")
    process.exitCode = 1
  }
}

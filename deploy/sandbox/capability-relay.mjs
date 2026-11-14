import { createServer as h2Server, connect as h2Connect, constants } from "node:http2"
import { createServer as httpServer, request as httpRequest } from "node:http"
import { createServer as socketServer, connect as socketConnect } from "node:net"
import { Duplex, pipeline } from "node:stream"
import { spawn } from "node:child_process"
import { chmod } from "node:fs/promises"
import { pathToFileURL } from "node:url"

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

/** Node owns the framing/window/reset machinery; SSH carries only its byte stream. */
export function attachController(server, ssh) {
  const wire = Duplex.from({ readable: ssh.stdout, writable: ssh.stdin })
  wire.on("error", () => {
    wire.destroy()
    ssh.kill("SIGKILL")
  })
  ssh.once("error", () => wire.destroy())
  ssh.once("exit", () => wire.destroy())
  server.emit("connection", wire)
  return wire
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

function bridgeController(config) {
  if (
    !Array.isArray(config.ssh) ||
    config.ssh[0] !== "/usr/bin/ssh" ||
    config.ssh.at(-1) !== "exec /usr/local/bin/runner-control capabilities" ||
    typeof config.backend !== "string" ||
    !config.backend.startsWith("/")
  )
    throw new Error("relay configuration refused")
  const server = h2Server({
    maxSessionMemory: 8,
    maxHeaderListPairs: 32,
    settings: { maxConcurrentStreams: 4, maxHeaderListSize: 8192, initialWindowSize: 65535 },
  })
  const ssh = spawn(config.ssh[0], config.ssh.slice(1), {
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
    stdio: ["pipe", "pipe", "ignore"],
  })
  let session
  server.on("session", (current) => {
    session = current
    current.once("remoteSettings", () => process.stdout.write("ready\n"))
    current.on("error", () => current.destroy())
    current.once("close", () => stop())
  })
  server.on("stream", (stream, headers) => {
    // Rejected streams also remain peer-controlled until close.
    stream.on("error", () => stream.destroy())
    if (stream.destroyed) return
    const target = headers[":path"]
    if (
      headers[":authority"] !== "capability.invalid" ||
      typeof target !== "string" ||
      !(
        gitReadRoute(headers[":method"], target) ||
        (headers[":method"] === "POST" &&
          /^\/capabilities\/v1\/(?:renew|result|providers\/(?:anthropic\/v1\/messages(?:\/count_tokens)?(?:\?beta=true)?|[A-Za-z0-9_-]{1,128}\/(?:responses|chat\/completions)))$/.test(
            target,
          ))
      )
    ) {
      stream.respond({ ":status": 403 })
      stream.end()
      return
    }
    const forwarded = Object.fromEntries(
      Object.entries(headers).filter(([key]) => !key.startsWith(":")),
    )
    if (
      [
        "host",
        "connection",
        "keep-alive",
        "proxy-authorization",
        "proxy-connection",
        "transfer-encoding",
        "upgrade",
        "te",
        "trailer",
      ].some((key) => key in forwarded)
    ) {
      stream.respond({ ":status": 403 })
      stream.end()
      return
    }
    const request = httpRequest(
      {
        socketPath: config.backend,
        path: target,
        method: headers[":method"],
        headers: { ...forwarded, host: "capability.invalid" },
        maxHeaderSize: 8192,
      },
      (response) => {
        const responseHeaders = Object.fromEntries(
          Object.entries(response.headers).filter(
            ([key]) => !["connection", "transfer-encoding", "keep-alive"].includes(key),
          ),
        )
        if (stream.destroyed) {
          response.destroy()
          return
        }
        stream.respond({ ...responseHeaders, ":status": response.statusCode ?? 503 })
        pipeline(response, stream, (error) => {
          if (error) request.destroy()
        })
      },
    )
    request.setTimeout(120000, () => request.destroy())
    stream.once("close", () => request.destroy())
    request.once("error", () => stream.close(constants.NGHTTP2_CANCEL))
    pipeline(stream, request, (error) => {
      if (error) stream.close(constants.NGHTTP2_CANCEL)
    })
  })
  const wire = attachController(server, ssh)
  const stop = () => {
    session?.destroy()
    wire.destroy()
    ssh.kill("SIGKILL")
    server.close()
  }
  // An EOF in either SSH direction ends this channel, including partial frames.
  wire.once("end", stop)
  ssh.once("exit", (code) => {
    stop()
    process.exitCode = code === 0 ? 0 : 1
  })
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
}

export async function serveRunnerRelay(config, directory = root) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(config.token) ||
    !Number.isSafeInteger(config.expiresAt) ||
    !Number.isSafeInteger(config.renewAt) ||
    !Number.isSafeInteger(config.deadline) ||
    config.expiresAt > config.deadline
  )
    throw new Error("relay configuration refused")
  let credential = config
  let client
  let renewal
  let attached = false
  let streams = 0
  let closed = false
  const sockets = new Set()
  const http = httpServer(
    { maxHeaderSize: 8192, requestTimeout: 120000, headersTimeout: 10000 },
    (request, response) => {
      if (
        !client ||
        client.closed ||
        client.destroyed ||
        streams >= 4 ||
        Date.now() >= credential.expiresAt
      ) {
        response.writeHead(503, { "retry-after": "5" })
        response.end()
        return
      }
      if (
        !(
          gitReadRoute(request.method, request.url) ||
          (request.method === "POST" &&
            (request.url === "/capabilities/v1/result" ||
              /^\/v1\/messages(?:\/count_tokens)?(?:\?beta=true)?$/.test(request.url ?? "") ||
              /^\/capabilities\/v1\/providers\/[A-Za-z0-9_-]{1,128}\/(?:responses|chat\/completions)$/.test(
                request.url ?? "",
              )))
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
      let stream
      try {
        stream = client.request({
          ...headers,
          ":method": request.method,
          ":path": request.url.startsWith("/capabilities/v1/")
            ? request.url
            : `/capabilities/v1/providers/anthropic${request.url}`,
          ":authority": "capability.invalid",
          authorization: `Bearer ${credential.token}`,
        })
      } catch {
        response.writeHead(503, { "retry-after": "1" })
        response.end()
        return
      }
      streams++
      stream.on("response", (reply) => {
        const output = Object.fromEntries(
          Object.entries(reply).filter(([key]) => !key.startsWith(":")),
        )
        response.writeHead(reply[":status"] ?? 503, output)
        pipeline(stream, response, (error) => {
          if (error) stream.close(constants.NGHTTP2_CANCEL)
        })
      })
      stream.once("close", () => {
        streams--
        if (!response.writableEnded) response.destroy()
      })
      stream.once("error", () => response.destroy())
      response.once("close", () => {
        if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL)
      })
      pipeline(request, stream, (error) => {
        if (error) stream.close(constants.NGHTTP2_CANCEL)
      })
    },
  )
  http.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  const control = socketServer((socket) => {
    if (attached) {
      socket.destroy()
      return
    }
    attached = true
    clearTimeout(startup)
    client = h2Connect("http://capability.invalid", {
      createConnection: () => socket,
      settings: { initialWindowSize: 65535, maxHeaderListSize: 8192 },
    })
    client.once("error", stop)
    client.once("close", stop)
    let failures = 0
    const renew = async () => {
      let retryable = true
      try {
        const stream = client.request({
          ":method": "POST",
          ":path": "/capabilities/v1/renew",
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
        })
        stream.setTimeout(10000, () => stream.close(constants.NGHTTP2_CANCEL))
        let status
        stream.once("response", (headers) => {
          status = headers[":status"]
        })
        stream.end("{}")
        let raw = ""
        for await (const bytes of stream) {
          raw += bytes.toString()
          if (raw.length > 4096) throw new Error("renewal refused")
        }
        retryable = status === 429 || status === 503
        if (status !== 200) throw new Error("renewal unavailable")
        const next = JSON.parse(raw)
        if (
          status !== 200 ||
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
        expiry = setTimeout(stop, next.expiresAt - Date.now())
        renewal = setTimeout(renew, next.renewAt - Date.now())
      } catch {
        const remaining = credential.expiresAt - Date.now()
        if (!retryable || remaining <= 0) {
          stop()
          return
        }
        // Retry only renewal of the same predecessor, never inference. Exhaustion
        // leaves existing authority usable until its original expiry timer fires.
        if (failures++ < 6) {
          const delay = Math.min(30000, 1000 * 2 ** (failures - 1))
          const jittered = delay + Math.floor((Math.random() * delay) / 4)
          if (jittered < remaining) renewal = setTimeout(renew, jittered)
        }
      }
    }
    renewal = setTimeout(renew, Math.max(0, credential.renewAt - Date.now()))
  })
  const deadline = setTimeout(() => stop(), Math.max(0, config.deadline - Date.now()))
  let expiry = setTimeout(() => stop(), Math.max(0, config.expiresAt - Date.now()))
  const startup = setTimeout(() => stop(), 60000)
  function stop() {
    if (closed) return
    closed = true
    clearTimeout(deadline)
    clearTimeout(expiry)
    clearTimeout(startup)
    clearTimeout(renewal)
    for (const socket of sockets) socket.destroy()
    client?.destroy()
    http.close()
    control.close()
  }
  for (const [server, file] of [
    [http, "gateway.sock"],
    [control, "capability.sock"],
  ]) {
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(`${directory}/${file}`, resolve)
    })
    await chmod(`${directory}/${file}`, 0o600)
  }
  return { close: stop }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "controller") bridgeController(await configInput())
    else if (process.argv[2] === "runner") {
      const relay = await serveRunnerRelay(await configInput())
      process.stdout.write("ready\n")
      process.once("SIGTERM", relay.close)
    } else if (process.argv[2] === "attach") {
      const socket = socketConnect(`${root}/capability.sock`)
      pipeline(process.stdin, socket, (error) => {
        if (error) socket.destroy()
      })
      pipeline(socket, process.stdout, (error) => {
        if (error) socket.destroy()
      })
    } else throw new Error("relay operation refused")
  } catch {
    process.stderr.write("capability relay unavailable\n")
    process.exitCode = 1
  }
}

import { readFileSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { createServer } from "node:net"
import { Schema } from "effect"
import type { Socket } from "node:net"
import { dlopen, FFIType, ptr } from "bun:ffi"

function processIdentity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  return { parent: Number(fields[1]), started: fields[19] }
}

/** Process birth time prevents a recycled root PID from inheriting custody. */
export class RunPeers {
  private readonly roots = new Map<string, { pid: number; started: string | undefined }>()
  register(runId: string, pid: number) {
    this.roots.set(runId, { pid, started: processIdentity(pid).started })
  }
  revoke(runId: string) {
    this.roots.delete(runId)
  }
  allows(runId: string, peerPid: number | undefined): boolean {
    const root = this.roots.get(runId)
    if (root === undefined || peerPid === undefined) return false
    try {
      if (processIdentity(root.pid).started !== root.started) return false
      let pid = peerPid
      for (let depth = 0; pid > 1 && depth < 256; depth++) {
        if (pid === root.pid) return true
        const parent = processIdentity(pid).parent
        if (parent === pid) return false
        pid = parent
      }
    } catch {
      return false
    }
    return false
  }
}

/** Linux only: fail closed on hosts without a kernel-supplied peer PID. */
export async function serveRunSocket(
  path: string,
  route: (request: Request, peerPid: number) => Promise<Response | undefined>,
) {
  if (process.platform !== "linux") throw new Error("Run sockets require Linux SO_PEERCRED")
  const libc = dlopen("libc.so.6", {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const peerPid = (socket: Socket) => {
    // node:http on Bun exposes the accepted native descriptor through _handle.
    const handle: unknown = Reflect.get(socket, "_handle")
    const fd: unknown =
      typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined
    if (typeof fd !== "number") throw new Error("Peer socket descriptor unavailable")
    const credentials = new Int32Array(3)
    const length = new Uint32Array([12])
    if (
      libc.symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(length)) !== 0 ||
      length[0] !== 12 ||
      credentials[1] !== process.getuid?.() ||
      credentials[0]! <= 0
    )
      throw new Error("Peer credentials unavailable")
    return credentials[0]!
  }
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    socket.setTimeout(15000, () => socket.destroy())
    let data = ""
    let handled = false
    socket.on("data", (chunk) => {
      if (handled) return
      data += chunk.toString("utf8")
      if (data.length > 16384) {
        socket.destroy()
        return
      }
      if (!data.includes("\n")) return
      handled = true
      void (async () => {
        try {
          const pid = peerPid(socket)
          const input = Schema.decodeUnknownSync(
            Schema.Struct({
              path: Schema.String,
              body: Schema.optional(Schema.String),
            }),
          )(JSON.parse(data))
          const response =
            (await route(
              new Request(new URL(input.path, "http://localhost").toString(), {
                method: "POST",
                ...(input.body === undefined ? {} : { body: input.body }),
              }),
              pid,
            )) ?? new Response(null, { status: 404 })
          socket.end(
            JSON.stringify({ status: response.status, body: await response.text() }) + "\n",
          )
        } catch {
          socket.end('{"status":403,"body":""}\n')
        }
      })()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, resolve)
    })
    await chmod(path, 0o600)
  } catch (error) {
    server.close()
    libc.close()
    throw error
  }
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      libc.close()
    },
  }
}

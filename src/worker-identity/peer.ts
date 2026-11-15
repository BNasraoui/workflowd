import { readFileSync } from "node:fs"
import { chmod, chown, lstat, rm } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { Schema } from "effect"
import type { Socket } from "node:net"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { tryFileLock } from "../file-lock"

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

export type RunSocketPolicy = { controllerUid: number; agentUid: number; groupGid: number }

export function loadRunSocketPolicy(
  env: Record<string, string | undefined>,
): RunSocketPolicy | undefined {
  if (env.WORKFLOWD_AGENT_UID === undefined && env.WORKFLOWD_AGENT_GID === undefined)
    return undefined
  const agentUid = Number(env.WORKFLOWD_AGENT_UID),
    groupGid = Number(env.WORKFLOWD_AGENT_GID)
  const controllerUid = process.getuid!()
  if (
    ![agentUid, groupGid].every((id) => Number.isSafeInteger(id) && id > 0) ||
    agentUid === controllerUid
  )
    throw new Error("Agent socket identity requires a distinct non-root UID and group")
  return { controllerUid, agentUid, groupGid }
}

/** True when a process accepts a connect on the path. A failed connect proves nothing. */
function answersConnect(path: string) {
  return new Promise<boolean>((resolve) => {
    const probe = createConnection(path)
    const settle = (answered: boolean) => {
      probe.destroy()
      resolve(answered)
    }
    probe.once("connect", () => settle(true))
    probe.once("error", () => settle(false))
  })
}

/**
 * The daemon that serves a run socket holds an exclusive flock(2) on `<path>.lock` until the
 * server closes, and the kernel releases it when that process ends, SIGKILL included. With the
 * lock taken, a socket at the path has a dead owner and is removed, so the bind cannot fail with
 * EADDRINUSE on a file that a killed daemon left. A file, directory or symbolic link at the path
 * is not a socket that this daemon made, and it refuses the start and stays. Resolves to the
 * release of the lock.
 */
async function claimSocketPath(path: string) {
  const release = await tryFileLock(`${path}.lock`, process.getuid!(), true)
  if (release === undefined)
    throw new Error(`${path} is locked by a live process; refusing to bind it`)
  try {
    // An unreadable path is left to bind, which reports its own error.
    const entry = await lstat(path).catch(() => null)
    if (entry === null) return release
    if (!entry.isSocket())
      throw new Error(`${path} exists and is not a socket; refusing to remove it`)
    // A process that does not take the lock, such as an older daemon, can still serve the path.
    if (await answersConnect(path))
      throw new Error(`${path} is held by a live process; refusing to remove it`)
    await rm(path, { force: true })
    return release
  } catch (error) {
    await release()
    throw error
  }
}

/** Linux only: fail closed on hosts without a kernel-supplied peer PID. */
export async function serveRunSocket(
  path: string,
  route: (request: Request, peerPid: number) => Promise<Response | undefined>,
  policy?: RunSocketPolicy,
) {
  if (process.platform !== "linux") throw new Error("Run sockets require Linux SO_PEERCRED")
  const release = await claimSocketPath(path)
  const libc = dlopen("libc.so.6", {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const peerPid = (socket: Socket) => {
    // node:net on Bun exposes the accepted native descriptor through _handle.
    const handle: unknown = Reflect.get(socket, "_handle")
    const fd: unknown =
      typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined
    if (typeof fd !== "number") throw new Error("Peer socket descriptor unavailable")
    const credentials = new Int32Array(3)
    const length = new Uint32Array([12])
    if (
      libc.symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(length)) !== 0 ||
      length[0] !== 12 ||
      !(policy ? [policy.controllerUid, policy.agentUid] : [process.getuid?.()]).includes(
        credentials[1],
      ) ||
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
    if (policy) await chown(path, process.getuid!(), policy.groupGid)
    await chmod(path, policy ? 0o660 : 0o600)
  } catch (error) {
    server.close()
    libc.close()
    await release()
    throw error
  }
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      // Bun removes the socket file as the server closes; the next daemon then finds no entry.
      await new Promise<void>((resolve) => server.close(() => resolve()))
      libc.close()
      await release()
    },
  }
}

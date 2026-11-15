import { lstat, rm } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { tryFileLock } from "./file-lock"

const openLibc = () =>
  dlopen("libc.so.6", {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
// Opened once, for the life of the process.
let libc: ReturnType<typeof openLibc> | undefined

/**
 * The process at the other end of an accepted Unix socket, as the kernel records it at connect
 * (SO_PEERCRED): nothing the caller sends is read. Linux only. Undefined when the kernel gives no
 * answer, so each caller fails closed.
 */
export function peerCredentials(socket: Socket) {
  // node:net on Bun exposes the accepted native descriptor through _handle.
  const handle: unknown = Reflect.get(socket, "_handle")
  const fd: unknown =
    typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined
  if (typeof fd !== "number") return undefined
  const credentials = new Int32Array(3)
  const length = new Uint32Array([12])
  // SOL_SOCKET is 1 and SO_PEERCRED is 17; the answer is pid, uid and gid.
  if (
    (libc ??= openLibc()).symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(length)) !== 0 ||
    length[0] !== 12
  )
    return undefined
  return { pid: credentials[0]!, uid: credentials[1]!, gid: credentials[2]! }
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
 * Claims a Unix socket path for a server of this process. The server holds an exclusive flock(2)
 * on `<path>.lock` until it closes, and the kernel releases it when the process ends, SIGKILL
 * included. With the lock taken, a socket at the path has a dead owner and is removed, so the bind
 * cannot fail with EADDRINUSE on a file that a killed server left. A file, directory or symbolic
 * link at the path, a socket of another uid, or a socket that a process still serves is refused
 * and stays. Resolves to the release of the lock.
 */
export async function claimSocketPath(path: string) {
  const uid = process.getuid!()
  const release = await tryFileLock(`${path}.lock`, uid, true)
  if (release === undefined)
    throw new Error(`${path} is locked by a live process; refusing to bind it`)
  try {
    // An unreadable path is left to bind, which reports its own error.
    const entry = await lstat(path).catch(() => null)
    if (entry === null) return release
    if (!entry.isSocket())
      throw new Error(`${path} exists and is not a socket; refusing to remove it`)
    if (entry.uid !== uid)
      throw new Error(`${path} is a socket of another user; refusing to remove it`)
    // A process that does not take the lock, such as an older server, can still serve the path.
    if (await answersConnect(path))
      throw new Error(`${path} is held by a live process; refusing to remove it`)
    await rm(path, { force: true })
    return release
  } catch (error) {
    await release()
    throw error
  }
}

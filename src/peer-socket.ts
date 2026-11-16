import { chmod, chown, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { dirname } from "node:path"
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

/** How a socket's directory names itself in its errors: the socket and the group that reaches it. */
export interface SocketRole {
  readonly socket: string
  readonly group: string
}

/**
 * Refuses a socket directory that a user other than root and this process's uid could replace.
 * Its parent is named by its real path (no symbolic link above the directory), and each directory
 * from the parent up to `/` is owned by root (uid 0) or this uid, and either lets neither its
 * group nor others write to it (mode & 0o022 is 0) or has the sticky bit (mode & 0o1000). The
 * sticky bit lets only an entry's owner, the directory's owner and root rename or remove the
 * entry, and each entry on the path is owned by root or this uid. `/` may also show the kernel's
 * overflow uid: a user namespace shows it for an owner that it does not map, as the host's root,
 * and `/` itself cannot be renamed or replaced.
 */
async function checkAncestors(directory: string, uid: number, role: SocketRole) {
  const parent = dirname(directory)
  if ((await realpath(parent)) !== parent)
    throw new Error(`${role.socket} directory must be named by its real path`)
  const overflow = Number(
    (await readFile("/proc/sys/kernel/overflowuid", "utf8").catch(() => "")).trim() || -1,
  )
  for (let above = parent; ; above = dirname(above)) {
    const info = await lstat(above)
    const owners = above === "/" ? [0, uid, overflow] : [0, uid]
    if (
      !info.isDirectory() ||
      !owners.includes(info.uid) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    )
      throw new Error(`${above} lets another user replace the ${role.socket} directory`)
    if (above === "/") return
  }
}

/**
 * The directory of a socket is this process's own: owned by its uid, with the group `gid`, mode
 * `mode`, under directories that pass `checkAncestors`. It is made when it is missing; anything
 * else is refused.
 */
async function claimSocketDirectory(
  directory: string,
  uid: number,
  gid: number,
  mode: number,
  role: SocketRole,
) {
  await checkAncestors(directory, uid, role)
  const existing = await lstat(directory).catch(() => null)
  if (existing === null) {
    await mkdir(directory, { mode: 0o700 })
    await chown(directory, uid, gid)
    await chmod(directory, mode)
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.uid !== uid || info.gid !== gid || (info.mode & 0o7777) !== mode)
    throw new Error(
      `${role.socket} directory must be the gateway's, mode ${mode.toString(8).padStart(4, "0")}, ${role.group}`,
    )
}

/** A server that listens on a Unix socket path: node:net's or node:http's. */
interface SocketServer {
  listen(path: string, listening: () => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  removeListener(event: "error", listener: (error: Error) => void): unknown
  close(closed?: () => void): unknown
}

/**
 * Serves `server` on the Unix socket `path`: the directory of the path is claimed for this uid
 * and `gid` with `mode` (`claimSocketDirectory`), the path itself with `claimSocketPath`, and the
 * socket gets this uid, `gid` and mode 0660. So only this uid, `gid` and root reach it. Resolves to
 * its close, which stops the server, removes the socket and releases the path.
 */
export async function serveSocket(
  server: SocketServer,
  path: string,
  gid: number,
  mode: number,
  role: SocketRole,
) {
  if (process.platform !== "linux") throw new Error(`the ${role.socket} needs SO_PEERCRED`)
  const uid = process.getuid!()
  await claimSocketDirectory(dirname(path), uid, gid, mode, role)
  const release = await claimSocketPath(path)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    await chown(path, uid, gid)
    await chmod(path, 0o660)
  } catch (error) {
    server.close()
    await release()
    throw error
  }
  return () =>
    new Promise<void>((resolve) => server.close(() => resolve()))
      .then(() => rm(path, { force: true }))
      .then(release)
      .catch(() => undefined)
}

import { lstat } from "node:fs/promises"
import { join } from "node:path"

/** Starts a child process and waits for its first line, which it prints once it holds the path. */
async function holdInChild(command: string[], path: string) {
  const child = Bun.spawn(command, {
    env: { PATH: process.env.PATH, SOCKET: path },
    stdout: "pipe",
  })
  const { value } = await child.stdout.getReader().read()
  if (value === undefined) throw new Error(`the holder of ${path} ended before it held it`)
  return child
}

/** Binds the path in a child process and kills it with SIGKILL, as systemd does after a slow stop. */
export async function leaveStaleSocket(path: string) {
  const child = await holdInChild(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(process.env.SOCKET, () => console.log("bound"))`,
    ],
    path,
  )
  child.kill("SIGKILL")
  await child.exited
  if (!(await lstat(path)).isSocket()) throw new Error(`${path} was not left as a socket`)
}

/** A second daemon process: it serves the path through serveRunSocket until it is killed. */
export function serveRunSocketInChild(path: string) {
  const peer = JSON.stringify(join(import.meta.dir, "../../src/worker-identity/peer.ts"))
  return holdInChild(
    [
      process.execPath,
      "-e",
      `const { serveRunSocket } = await import(${peer})
       await serveRunSocket(process.env.SOCKET, async () => undefined)
       console.log("serving")`,
    ],
    path,
  )
}

/** A process that holds the lock of the path, as a daemon does, and has a datagram socket bound there. */
export function holdDatagramSocketInChild(path: string) {
  return holdInChild(
    [
      "python3",
      "-c",
      `import fcntl, os, socket, time
path = os.environ["SOCKET"]
lock = os.open(path + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
datagram = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
datagram.bind(path)
print("bound", flush=True)
time.sleep(600)`,
    ],
    path,
  )
}

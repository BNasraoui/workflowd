import { homedir } from "node:os"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { RpcClient } from "../resident/rpc"

/** A catalog observation owns a short-lived app-server; it never creates or resumes a thread. */
export function startCodexDiscovery(
  command: ReadonlyArray<string>,
  home: string | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const child = Bun.spawn(Array.from(command), {
    cwd: homedir(),
    env: { ...process.env, ...(home === undefined ? {} : { CODEX_HOME: home }) },
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const rpc = new RpcClient(
    (line) => {
      child.stdin.write(line)
      void child.stdin.flush()
    },
    () => {},
  )
  const input = Readable.fromWeb(child.stdout)
  const reader = createInterface({ input, crlfDelay: Infinity })
  const terminate = () => {
    rpc.close()
    reader.close()
    input.destroy()
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
  let totalBytes = 0
  let bufferedBytes = 0
  input.on("data", (chunk: unknown) => {
    if (!Buffer.isBuffer(chunk)) {
      terminate()
      return
    }
    totalBytes += chunk.byteLength
    const newline = chunk.lastIndexOf(10)
    bufferedBytes =
      newline === -1 ? bufferedBytes + chunk.byteLength : chunk.byteLength - newline - 1
    if (totalBytes > 8_000_000 || bufferedBytes > 2_000_000) terminate()
  })
  reader.on("line", (line) => {
    try {
      if (line.length > 2_000_000) {
        terminate()
        return
      }
      rpc.receive(line)
    } catch {
      terminate()
    }
  })
  signal.addEventListener("abort", terminate, { once: true })
  void child.exited.then(
    () => {
      rpc.close()
      reader.close()
    },
    () => {
      rpc.close()
      reader.close()
    },
  )
  return {
    request: (method: string, params: unknown) => rpc.request(method, params),
    initialize: async () => {
      await rpc.request("initialize", {
        clientInfo: { name: "workflowd-capabilities", version: "1" },
      })
      child.stdin.write('{"method":"initialized"}\n')
      void child.stdin.flush()
    },
    close: async () => {
      signal.removeEventListener("abort", terminate)
      terminate()
      await child.exited
    },
  }
}

import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { RpcClient } from "./rpc"

/** Owns exactly one stdio app-server process. Never connects to a managed daemon. */
export function startAppServer(
  options: {
    readonly binary: string
    readonly home: string
    readonly env?: Readonly<Record<string, string>>
  },
  notify: (frame: { readonly method: string; readonly params: unknown }) => void,
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    CODEX_HOME: options.home,
    GH_CONFIG_DIR: join(options.home, "worker-gh"),
  }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN
  const child = Bun.spawn([options.binary, "app-server", "--listen", "stdio://"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const rpc = new RpcClient((line) => {
    child.stdin.write(line)
    void child.stdin.flush()
  }, notify)
  const reader = createInterface({ input: Readable.fromWeb(child.stdout), crlfDelay: Infinity })
  reader.on("line", (line) => {
    try {
      rpc.receive(line)
    } catch {
      rpc.close()
      child.kill()
    }
  })
  void child.exited.then(() => {
    rpc.close()
    reader.close()
    notify({ method: "workflowd/disconnected", params: null })
  })
  return {
    pid: child.pid,
    rpc,
    initialize: async () => {
      await rpc.request("initialize", {
        clientInfo: { name: "workflowd", version: "1" },
        capabilities: { experimentalApi: true },
      })
      child.stdin.write('{"method":"initialized"}\n')
      void child.stdin.flush()
    },
    close: async () => {
      rpc.close()
      reader.close()
      child.kill()
      await child.exited
    },
  }
}

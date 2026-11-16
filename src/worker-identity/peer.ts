import { readFileSync } from "node:fs"
import { chmod, chown } from "node:fs/promises"
import { createServer } from "node:net"
import { Schema } from "effect"
import type { Socket } from "node:net"
import { claimSocketPath, peerCredentials } from "../peer-socket"

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

/** Linux only: fail closed on hosts without a kernel-supplied peer PID. */
export async function serveRunSocket(
  path: string,
  route: (request: Request, peerPid: number) => Promise<Response | undefined>,
  policy?: RunSocketPolicy,
) {
  if (process.platform !== "linux") throw new Error("Run sockets require Linux SO_PEERCRED")
  const release = await claimSocketPath(path)
  const peerPid = (socket: Socket) => {
    const credentials = peerCredentials(socket)
    if (
      credentials === undefined ||
      !(policy ? [policy.controllerUid, policy.agentUid] : [process.getuid?.()]).includes(
        credentials.uid,
      ) ||
      credentials.pid <= 0
    )
      throw new Error("Peer credentials unavailable")
    return credentials.pid
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
    await release()
    throw error
  }
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      // Bun removes the socket file as the server closes; the next daemon then finds no entry.
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await release()
    },
  }
}

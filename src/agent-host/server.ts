import { checkOpenCodeMigration } from "./opencode-credentials"
import { chmod, chown, lstat, readFile, unlink } from "node:fs/promises"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { Schema } from "effect"
import { CredentialPolicy } from "./config"
import { credentialLock, inspectCredentialLayout } from "./credentials"
import { CredentialRequest, credentialReason, credentialRefusal } from "./protocol"

/** One authenticated connection holds one shared admission lease until its handoff completes. */
export async function serveCredentialHost(path: string, policy: CredentialPolicy) {
  const libc = dlopen("libc.so.6", {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const server = createServer((socket) => {
    sockets.add(socket)
    let release: (() => Promise<void>) | undefined
    socket.on("error", () => socket.destroy())
    socket.on("close", () => {
      sockets.delete(socket)
      if (release) void release()
    })
    socket.setTimeout(15000, () => socket.destroy())
    let data = ""
    let handled = false
    socket.on("data", (chunk) => {
      if (handled) return
      data += chunk.toString("utf8")
      if (data.length > 1024) {
        socket.destroy()
        return
      }
      if (!data.includes("\n")) return
      handled = true
      const operation = (async () => {
        try {
          const handle: unknown = Reflect.get(socket, "_handle")
          const fd: unknown =
            typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined
          const credentials = new Int32Array(3)
          const length = new Uint32Array([12])
          if (
            typeof fd !== "number" ||
            libc.symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(length)) !== 0 ||
            length[0] !== 12 ||
            credentials[1] !== policy.controllerUid ||
            credentials[0]! <= 0
          )
            throw credentialRefusal("codex", "shared_credential_permissions_invalid")
          const request = Schema.decodeUnknownSync(CredentialRequest, {
            onExcessProperty: "error",
          })(JSON.parse(data))
          release = await credentialLock(policy, false)
          if (request.client === "opencode") {
            if (!policy.opencode)
              throw credentialRefusal(request.client, "opencode_grant_migration_incomplete")
            await checkOpenCodeMigration(policy.opencode)
          } else await inspectCredentialLayout(policy, request.client)
          if (socket.destroyed) {
            await release()
            release = undefined
            return
          }
          socket.setTimeout(0)
          socket.write('{"admitted":true}\n')
          socket.on("end", () => {
            void (async () => {
              await release?.()
              release = undefined
              socket.end()
            })()
          })
        } catch (error) {
          await release?.()
          release = undefined
          socket.end(
            JSON.stringify({
              admitted: false,
              reason: credentialReason(error) ?? "shared_credential_permissions_invalid",
            }) + "\n",
          )
        }
      })()
      pending.add(operation)
      void operation.finally(() => pending.delete(operation))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, resolve)
    })
    await chmod(path, 0o600)
    await chown(path, policy.controllerUid, policy.groupGid)
  } catch (error) {
    server.close()
    libc.close()
    throw error
  }
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.all(pending)
      libc.close()
    },
  }
}

if (import.meta.main) {
  if (process.getuid?.() !== 0) throw new Error("Credential host requires root")
  const path = "/etc/workflowd/agent-host.json"
  const info = await lstat(path)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0)
    throw new Error("Unsafe host policy")
  const policy = Schema.decodeUnknownSync(CredentialPolicy)(
    JSON.parse(await readFile(path, "utf8")),
  )
  if (policy.ownerUid !== 0 || policy.agentUid === policy.controllerUid || policy.agentUid === 0)
    throw new Error("Invalid host identity")
  const socket = "/run/workflowd-agent-host/control.sock"
  await unlink(socket).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  })
  const host = await serveCredentialHost(socket, policy)
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      void host.close()
    })
}

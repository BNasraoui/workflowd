import { checkOpenCodeMigration } from "./opencode-credentials"
import {
  chmod,
  chown,
  lstat,
  readFile,
  unlink,
  mkdir,
  open,
  rename,
  realpath,
  readdir,
} from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { Schema } from "effect"
import { CredentialPolicy } from "./config"
import { credentialLock, inspectCredentialLayout } from "./credentials"
import {
  CredentialRequest,
  HostRequest,
  HostStart,
  OwnedProcess,
  agentHostUnitName,
  credentialReason,
  credentialRefusal,
} from "./protocol"

/** One authenticated connection holds one shared admission lease until its handoff completes. */
export async function serveCredentialHost(
  path: string,
  policy: CredentialPolicy,
  supervisor: (args: string[]) => Promise<string> = hostCommand,
) {
  const libc = dlopen("libc.so.6", {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const native = nativeHost(policy, supervisor)
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
      if (Buffer.byteLength(data) > 300000) {
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
          const raw: unknown = JSON.parse(data)
          if (
            typeof raw === "object" &&
            raw !== null &&
            "operation" in raw &&
            raw.operation !== "checkCredentials"
          ) {
            const request = Schema.decodeUnknownSync(HostRequest, { onExcessProperty: "error" })(
              raw,
            )
            const response = await native(request)
            if (request.operation === "connect") {
              if (!("process" in response) || !response.process?.active)
                throw new Error("host server inactive")
              await relayHostSocket(socket, policy, request.runId)
              socket.write(JSON.stringify({ admitted: true, ...response }) + "\n")
            } else socket.end(JSON.stringify({ admitted: true, ...response }) + "\n")
            return
          }
          const request = Schema.decodeUnknownSync(CredentialRequest, {
            onExcessProperty: "error",
          })(raw)
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
              reason: credentialReason(error) ?? "host_request_refused",
              ...hostFailureDetail(error),
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

async function relayHostSocket(socket: Socket, policy: CredentialPolicy, runId: string) {
  const io = join(policy.launch!.ioRoot, hostDigest(runId))
  // Codex 0.159.1 hashes the advertised path into its fixed /tmp/codex-daemon-UID
  // directory. The unit bind-mounts that directory from this run's exchange.
  // Ignore the advertised symlink entirely; never resolve an agent-selected target.
  const path = join(io, "daemon", hostDigest(join(io, "rpc.sock")))
  let connected: WebSocket | undefined
  const deadline = Date.now() + 10000
  for (let attempt = 0; attempt < 50 && Date.now() < deadline && !socket.destroyed; attempt++) {
    // Linux O_PATH pins the socket inode without opening it for data access.
    const file = await open(path, 0x200000 | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
      throw error
    })
    if (file !== null) {
      try {
        const info = await file.stat()
        if (!info.isSocket() || info.uid !== policy.agentUid) throw new Error("unsafe host socket")
        const candidate = new WebSocket(`ws+unix:///proc/self/fd/${file.fd}`)
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              candidate.close()
              reject(new Error("host socket unavailable"))
            }, 1000)
            candidate.addEventListener(
              "open",
              () => {
                clearTimeout(timer)
                resolve()
              },
              { once: true },
            )
            candidate.addEventListener(
              "error",
              () => {
                clearTimeout(timer)
                reject(new Error("host socket unavailable"))
              },
              { once: true },
            )
          })
          connected = candidate
          break
        } catch {
          candidate.close()
        }
      } finally {
        await file.close()
      }
    }
    await Bun.sleep(50)
  }
  if (!connected) throw new Error("host socket unavailable")
  const ws = connected
  socket.setTimeout(0)
  socket.on("close", () => ws.close())
  ws.addEventListener("close", () => socket.destroy())
  ws.addEventListener("message", (event) => {
    const frame = String(event.data)
    if (Buffer.byteLength(frame) > 2000000 || socket.writableLength > 2000000) socket.destroy()
    else socket.write(frame + "\n")
  })
  let buffered = ""
  let sending = Promise.resolve()
  let queuedBytes = 0
  socket.on("data", (chunk) => {
    buffered += chunk.toString()
    if (Buffer.byteLength(buffered) > 2000000) {
      socket.destroy()
      return
    }
    let end: number
    while ((end = buffered.indexOf("\n")) >= 0) {
      const frame = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      const size = Buffer.byteLength(frame)
      queuedBytes += size
      if (queuedBytes > 2000000) {
        socket.destroy()
        return
      }
      sending = sending
        .then(() => sendHostFrame(socket, ws, policy, frame))
        .catch(() => socket.destroy())
        .then(() => {
          queuedBytes -= size
        })
    }
  })
}

async function sendHostFrame(
  socket: Socket,
  ws: WebSocket,
  policy: CredentialPolicy,
  frame: string,
) {
  if (socket.destroyed) return
  const message = Schema.decodeUnknownSync(
    Schema.Struct({
      method: Schema.optionalKey(Schema.String),
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    }),
  )(JSON.parse(frame))
  if (
    !["thread/start", "thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(
      message.method ?? "",
    )
  ) {
    ws.send(frame)
    return
  }
  let release: (() => Promise<void>) | undefined
  try {
    release = await credentialLock(policy, false)
    await inspectCredentialLayout(policy, "codex")
    if (!socket.destroyed) ws.send(frame)
  } catch (error) {
    const reason = credentialReason(error)
    if (!reason || message.id === undefined) throw error
    socket.write(JSON.stringify({ id: message.id, error: { code: -32001, reason } }) + "\n")
  } finally {
    await release?.()
  }
}

function hostFailureDetail(error: unknown) {
  const safe = new Set([
    "host path is not canonical",
    "unsafe host path",
    "unsafe host ancestry",
    "unsafe host exchange file",
    "host manager command failed; custody retained",
    "native launch policy unavailable",
    "host directory outside workspace policy",
    "host invocation identity mismatch",
    "host launch remains unconfirmed",
    "host server inactive",
    "host socket unavailable",
    "unsafe host socket",
  ])
  return error instanceof Error && safe.has(error.message) ? { detail: error.message } : {}
}

const HostRecord = Schema.Struct({
  request: HostStart,
  process: OwnedProcess,
  digest: Schema.String,
  cancelled: Schema.Boolean,
})
type HostRecord = typeof HostRecord.Type

const hostDigest = (value: string) => createHash("sha256").update(value).digest("hex")
const hostUnit = agentHostUnitName

async function trustedPath(path: string, owner: number, directory: boolean) {
  if ((await realpath(path)) !== path) throw new Error("host path is not canonical")
  const info = await lstat(path)
  if (info.uid !== owner || info.mode & 0o022 || info.isDirectory() !== directory)
    throw new Error("unsafe host path")
  for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
    const entry = await lstat(parent)
    if (
      !entry.isDirectory() ||
      (entry.uid !== 0 && entry.uid !== owner) ||
      ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0)
    )
      throw new Error("unsafe host ancestry")
  }
}

async function readHostFile(path: string, limit: number, offset = 0, uid?: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid))
      throw new Error("unsafe host exchange file")
    const bytes = Buffer.alloc(limit)
    const read = await file.read(bytes, 0, limit, offset)
    return bytes.subarray(0, read.bytesRead)
  } finally {
    await file.close()
  }
}

async function saveHostRecord(path: string, record: HostRecord) {
  const temporary = `${path}.${randomUUID()}`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(record))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}

async function hostCommand(args: string[]) {
  const child = Bun.spawn(args, {
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  try {
    const [status, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (status !== 0 && !text.includes("LoadState=not-found"))
      throw new Error("host manager command failed; custody retained")
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** The system manager owns workers; connections own only bounded observations. */
function nativeHost(policy: CredentialPolicy, supervisor: (args: string[]) => Promise<string>) {
  let previous: Promise<unknown> = Promise.resolve()
  const dispatch = async (request: HostRequest) => {
    const launch = policy.launch
    if (!launch || policy.agentUid === 0 || policy.agentUid === policy.controllerUid)
      throw new Error("native launch policy unavailable")
    await trustedPath(launch.custodyRoot, policy.ownerUid, true)
    await trustedPath(launch.ioRoot, policy.ownerUid, true)
    if (request.operation === "listOwned") {
      const paths = (await readdir(launch.custodyRoot))
        .filter((path) => /^[a-f0-9]{64}\.json$/.test(path))
        .sort()
      const processes: OwnedProcess[] = []
      for (const name of paths.slice(request.cursor, request.cursor + 128)) {
        const path = join(launch.custodyRoot, name)
        const record = Schema.decodeUnknownSync(HostRecord)(
          JSON.parse((await readHostFile(path, 300000, 0, policy.ownerUid)).toString()),
        )
        if (record.request.profile === "codex-server")
          processes.push(await inspectHostProcess(record, path, supervisor))
      }
      return { processes, next: request.cursor + 128 < paths.length ? request.cursor + 128 : null }
    }
    const key = hostDigest(request.runId)
    const recordPath = join(launch.custodyRoot, `${key}.json`)
    const io = join(launch.ioRoot, key)
    const saved = await readHostFile(recordPath, 300000, 0, policy.ownerUid).then(
      (bytes) => Schema.decodeUnknownSync(HostRecord)(JSON.parse(bytes.toString())),
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
        throw error
      },
    )
    if (
      saved &&
      (saved.process.runId !== request.runId ||
        saved.process.unit !== hostUnit(request.runId) ||
        saved.process.uid !== policy.agentUid)
    )
      throw new Error("forged host custody")
    const inspect = (record: HostRecord) => inspectHostProcess(record, recordPath, supervisor)
    if (request.operation === "start") {
      const digest = hostDigest(JSON.stringify(request))
      if (saved) {
        if (saved.digest !== digest) throw new Error("host launch identity conflict")
        return { process: await inspect(saved) }
      }
      const release = await credentialLock(policy, false)
      try {
        if (!["claude-session", "workspace"].includes(request.profile))
          await inspectCredentialLayout(
            policy,
            request.profile.startsWith("codex") ? "codex" : "claude",
          )
        const normalized =
          request.directory === "" &&
          (request.profile.endsWith("-preflight") ||
            ["codex-discovery", "codex-server"].includes(request.profile))
            ? { ...request, directory: launch.workspaceRoot }
            : request
        const repository =
          request.profile === "workspace"
            ? launch.repositories?.find((value) => value.source === request.repository)
            : undefined
        if (request.profile === "workspace" && !repository)
          throw new Error("repository outside host policy")
        await prepareHostLaunch(
          policy,
          repository === undefined ? normalized : { ...normalized, repository: repository.remote },
          io,
        )
        const record: HostRecord = {
          request,
          digest,
          cancelled: false,
          process: {
            runId: request.runId,
            launchId: request.launchId ?? randomUUID(),
            unit: hostUnit(request.runId),
            invocationId: null,
            uid: policy.agentUid,
            pid: 0,
            started: new Date().toISOString(),
            active: false,
            exitCode: null,
          },
        }
        // Persist the fence before the manager call. Never repeat an uncertain launch.
        await saveHostRecord(recordPath, record)
        await supervisor(hostLaunchCommand(policy, record, io))
        return { process: await inspect(record) }
      } finally {
        await release()
      }
    }
    if (!saved) {
      if (request.operation === "inspect") return { process: null }
      throw new Error("host custody missing")
    }
    if (request.operation !== "inspect" && request.launchId !== saved.process.launchId)
      throw new Error("forged host launch nonce")
    if (request.operation === "exchange") {
      const bytes = await readHostFile(
        join(io, request.file),
        65536,
        request.offset,
        policy.agentUid,
      ).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return Buffer.alloc(0)
        throw error
      })
      return { bytes: bytes.toString("base64") }
    }
    const observed = await inspect(saved)
    if (request.operation === "stop" && observed.active) {
      await supervisor(["/usr/bin/systemctl", "stop", saved.process.unit])
      if ((await inspect(saved)).active) throw new Error("host cancellation unconfirmed")
      await saveHostRecord(recordPath, { ...saved, process: observed, cancelled: true })
      return { process: await inspect(saved) }
    }
    return { process: observed }
  }
  return (request: HostRequest) => {
    const current = previous.then(() => dispatch(request))
    previous = current.catch(() => {})
    return current
  }
}

async function inspectHostProcess(
  record: HostRecord,
  path: string,
  supervisor: (args: string[]) => Promise<string>,
): Promise<OwnedProcess> {
  const output = await supervisor([
    "/usr/bin/systemctl",
    "show",
    record.process.unit,
    "--no-pager",
    "--property=LoadState,ActiveState,SubState,MainPID,InvocationID,Description,User,ExecMainStatus,ExecMainCode",
  ])
  const fields = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  )
  const present = fields.LoadState !== "not-found"
  if (!present && record.process.invocationId === null)
    throw new Error("host launch remains unconfirmed")
  if (
    present &&
    (fields.Description !== `workflowd native ${record.process.launchId}` ||
      !fields.InvocationID ||
      Number(fields.User) !== record.process.uid ||
      (record.process.invocationId !== null && fields.InvocationID !== record.process.invocationId))
  )
    throw new Error("host invocation identity mismatch")
  if (present && record.process.invocationId === null) {
    record = { ...record, process: { ...record.process, invocationId: fields.InvocationID! } }
    await saveHostRecord(path, record)
  }
  const active =
    present &&
    fields.SubState !== "exited" &&
    ["active", "activating", "deactivating"].includes(fields.ActiveState ?? "")
  return {
    ...record.process,
    active,
    pid: Number(fields.MainPID ?? 0),
    exitCode: active
      ? null
      : record.cancelled
        ? -1
        : present && fields.ExecMainCode === "1"
          ? Number(fields.ExecMainStatus)
          : -1,
  }
}

async function prepareHostLaunch(policy: CredentialPolicy, request: HostStart, io: string) {
  const launch = policy.launch!
  for (const path of [launch.bun, launch.worker, launch.codex, launch.claude])
    await trustedPath(path, policy.ownerUid, false)
  if (resolve(request.directory) !== request.directory)
    throw new Error("host directory outside workspace policy")
  const directory = await realpath(
    request.profile === "workspace" ? dirname(request.directory) : request.directory,
  )
  const workspace = await realpath(launch.workspaceRoot)
  if (
    directory !==
      (request.profile === "workspace" ? dirname(request.directory) : request.directory) ||
    (directory !== workspace && !directory.startsWith(`${workspace}/`))
  )
    throw new Error("host directory outside workspace policy")
  if (
    (request.profile === "claude-resume" || request.profile === "claude-session") &&
    !request.nativeSessionId
  )
    throw new Error("resume session required")
  await mkdir(io, { mode: 0o700 })
  const input = await open(join(io, "input"), "wx", 0o600)
  try {
    await input.writeFile(JSON.stringify(request))
    await input.sync()
  } finally {
    await input.close()
  }
  await chown(join(io, "input"), policy.agentUid, policy.groupGid)
  if (request.profile === "codex-server") {
    await mkdir(join(io, "daemon"), { mode: 0o700 })
    await chown(join(io, "daemon"), policy.agentUid, policy.groupGid)
  }
  await chown(io, policy.agentUid, policy.groupGid)
}

function hostLaunchCommand(policy: CredentialPolicy, record: HostRecord, io: string) {
  const launch = policy.launch!
  return [
    "/usr/bin/systemd-run",
    "--quiet",
    "--service-type=exec",
    `--unit=${record.process.unit}`,
    `--description=workflowd native ${record.process.launchId}`,
    `--working-directory=${record.request.profile === "workspace" ? launch.workspaceRoot : record.request.directory || launch.workspaceRoot}`,
    `--property=User=${policy.agentUid}`,
    `--property=Group=${policy.groupGid}`,
    "--property=RemainAfterExit=yes",
    "--property=SupplementaryGroups=",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=5",
    "--property=UMask=0077",
    "--property=NoNewPrivileges=yes",
    "--property=CapabilityBoundingSet=",
    "--property=PrivateDevices=yes",
    "--property=ProtectSystem=strict",
    ...(record.request.profile === "codex-server"
      ? [`--property=BindPaths=${io}/daemon:/tmp/codex-daemon-${policy.agentUid}`]
      : []),
    "--property=ProtectHome=yes",
    "--property=RestrictSUIDSGID=yes",
    "--property=MemoryMax=6G",
    "--property=MemorySwapMax=0",
    `--property=RuntimeMaxSec=${Math.ceil((record.request.timeoutMs ?? 86400000) / 1000)}`,
    `--property=ReadWritePaths=${launch.home} ${launch.workspaceRoot} ${io} ${policy.codex.canonical} ${policy.claude.canonical}`,
    "--setenv=WORKFLOWD_AGENT_HOST_SOCKET=host-managed",
    `--setenv=HOME=${launch.home}`,
    `--setenv=TMPDIR=${io}`,
    "--setenv=SHELL=/bin/bash",
    `--setenv=CODEX_HOME=${dirname(policy.codex.agentLink)}`,
    `--setenv=CLAUDE_CONFIG_DIR=${dirname(policy.claude.agentLink)}`,
    `--setenv=PATH=${dirname(launch.bun)}:/usr/bin:/bin`,
    `--setenv=XDG_CONFIG_HOME=${launch.home}/.config`,
    `--setenv=XDG_DATA_HOME=${launch.home}/.local/share`,
    `--setenv=XDG_STATE_HOME=${launch.home}/.local/state`,
    `--setenv=XDG_CACHE_HOME=${launch.home}/.cache`,
    launch.bun,
    launch.worker,
    "--host-input",
    join(io, "input"),
    "--binary",
    record.request.profile.startsWith("codex") ? launch.codex : launch.claude,
  ]
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

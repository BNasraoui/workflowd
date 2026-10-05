import { workerEnvironment } from "./environment"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, rm } from "node:fs/promises"
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
  const subscriptionConfig = `mcp_servers.workflowd_subscriptions={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(join(import.meta.dir, "mcp.ts"))}],env_vars=["WORKFLOWD_RUN_ID","WORKFLOWD_CODEX_RESIDENT_SOCKET"],required=true}`
  const child = Bun.spawn(
    [options.binary, "-c", subscriptionConfig, "app-server", "--listen", "stdio://"],
    {
      env,
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
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
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal)
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
    }
  }
  let closing: Promise<void> | undefined
  const stop = async () => {
    rpc.close()
    reader.close()
    signalGroup("SIGTERM")
    let force: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        child.exited,
        new Promise<void>((resolve) => {
          force = setTimeout(resolve, 1000)
        }),
      ])
      // The leader can exit before descendants; always terminate the remaining group.
      signalGroup("SIGKILL")
      await child.exited
    } finally {
      clearTimeout(force)
    }
  }
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
    close: () => (closing ??= stop()),
  }
}

export const residentUnitName = (runId: string, prefix = "workflowd-resident-") => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix)) throw new Error("invalid resident unit prefix")
  return `${prefix}${createHash("sha256").update(runId).digest("hex").slice(0, 24)}.service`
}

export const residentSocket = (home: string, runId: string) => {
  if (!/^agent-run-[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("unsafe resident run ID")
  return join(home, "servers", `${runId}.sock`)
}

const command = async (args: string[]) => {
  const child = Bun.spawn(args, {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0)
    throw new Error(`${args[0]} failed (${exitCode}): ${stderr.trim().slice(0, 300)}`)
  return stdout
}

export const inspectAppServerUnit = async (unit: string) => {
  const output = await command([
    "systemctl",
    "--user",
    "show",
    "--no-pager",
    "--property=LoadState",
    "--property=MainPID",
    "--property=InvocationID",
    "--property=Description",
    "--property=ActiveState",
    unit,
  ])
  const fields = new Map(
    output
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )
  return {
    present: fields.get("LoadState") !== "not-found",
    active: fields.get("ActiveState") === "active",
    pid: Number(fields.get("MainPID") ?? 0),
    invocation: fields.get("InvocationID") ?? "",
    description: fields.get("Description") ?? "",
  }
}

const assertUnit = (
  state: Awaited<ReturnType<typeof inspectAppServerUnit>>,
  launchId: string,
  invocation: string | null,
) => {
  if (
    state.present &&
    (state.description !== `workflowd resident launch ${launchId}` ||
      state.invocation === "" ||
      (invocation !== null && state.invocation !== invocation))
  )
    throw new Error("resident_unit_mismatch")
}

export const stopAppServer = async (unit: string, launchId: string, invocation: string | null) => {
  const before = await inspectAppServerUnit(unit)
  assertUnit(before, launchId, invocation)
  if (before.active) {
    try {
      await command(["systemctl", "--user", "stop", unit])
    } catch (error) {
      if ((await inspectAppServerUnit(unit)).active) throw error
    }
    try {
      await command(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit])
    } catch (error) {
      if ((await inspectAppServerUnit(unit)).active) throw error
    }
  }
  const after = await inspectAppServerUnit(unit)
  assertUnit(after, launchId, invocation)
  return { closed: !after.active }
}

const stopOrphanUnit = async (unit: string) => {
  try {
    await command(["systemctl", "--user", "stop", unit])
  } catch (error) {
    if ((await inspectAppServerUnit(unit)).active) throw error
  }
  try {
    await command(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit])
  } catch (error) {
    if ((await inspectAppServerUnit(unit)).active) throw error
  }
  if ((await inspectAppServerUnit(unit)).active)
    throw new Error(`Orphan resident unit ${unit} remains active`)
  return unit
}

export const sweepOrphanAppServers = async (prefix: string, active: ReadonlySet<string>) => {
  residentUnitName("agent-run-validation", prefix)
  const output = await command([
    "systemctl",
    "--user",
    "list-units",
    "--all",
    "--no-legend",
    `${prefix}*`,
  ])
  const orphans = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit): unit is string =>
      Boolean(unit?.startsWith(prefix) && unit.endsWith(".service") && !active.has(unit)),
    )
  return Promise.all(orphans.map(stopOrphanUnit))
}

const connectSocket = async (path: string, attempt = 0): Promise<WebSocket> => {
  if (attempt >= 50) throw new Error("resident socket unavailable")
  const socket = new WebSocket(`ws+unix://${path}`)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("resident socket upgrade failed")), {
        once: true,
      })
    })
    return socket
  } catch {
    socket.close()
    await Bun.sleep(50)
    return connectSocket(path, attempt + 1)
  }
}

export const attachAppServer = async (
  options: {
    readonly socket: string
    readonly unit: string
    readonly launchId: string
    readonly invocation: string | null
  },
  notify: (frame: { readonly method: string; readonly params: unknown }) => void,
) => {
  const state = await inspectAppServerUnit(options.unit)
  assertUnit(state, options.launchId, options.invocation)
  if (!state.active || !Number.isSafeInteger(state.pid) || state.pid <= 0)
    throw new Error("resident unit inactive")
  const connected = await connectSocket(options.socket)
  const rpc = new RpcClient((line) => connected.send(line.trimEnd()), notify)
  let detached = false
  const detach = () => {
    if (detached) return Promise.resolve()
    detached = true
    rpc.close()
    connected.close()
    return Promise.resolve()
  }
  connected.addEventListener("message", (event) => {
    try {
      rpc.receive(String(event.data))
    } catch {
      void detach()
    }
  })
  connected.addEventListener("close", () => {
    rpc.close()
    if (!detached) notify({ method: "workflowd/disconnected", params: null })
  })
  return {
    pid: state.pid,
    invocation: state.invocation,
    socket: options.socket,
    rpc,
    initialize: async () => {
      await rpc.request("initialize", {
        clientInfo: { name: "workflowd", version: "1" },
        capabilities: { experimentalApi: true },
      })
      connected.send(JSON.stringify({ method: "initialized" }))
    },
    detach,
    close: detach,
  }
}

export const launchAppServer = async (
  options: {
    readonly binary: string
    readonly home: string
    readonly env?: Readonly<Record<string, string>>
    readonly runId: string
    readonly unitPrefix?: string
    readonly launchId?: string
  },
  notify: (frame: { readonly method: string; readonly params: unknown }) => void,
) => {
  const unit = residentUnitName(options.runId, options.unitPrefix)
  const socket = residentSocket(options.home, options.runId)
  const launchId = options.launchId ?? randomUUID()
  await mkdir(join(options.home, "servers"), { recursive: true, mode: 0o700 })
  await chmod(join(options.home, "servers"), 0o700)
  const previous = await inspectAppServerUnit(unit)
  if (previous.active) throw new Error("resident unit already active")
  if (previous.present) await command(["systemctl", "--user", "reset-failed", unit])
  await rm(socket, { force: true })
  const environment: Record<string, string> = {
    ...workerEnvironment(),
    ...options.env,
    CODEX_HOME: options.home,
    GH_CONFIG_DIR: join(options.home, "worker-gh"),
  }
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "WORKFLOWD_NATS_CREDS",
  ])
    delete environment[key]
  const subscriptionConfig = `mcp_servers.workflowd_subscriptions={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(join(import.meta.dir, "mcp.ts"))}],env_vars=["WORKFLOWD_RUN_ID","WORKFLOWD_CODEX_RESIDENT_SOCKET"],required=true}`
  await command([
    "systemd-run",
    "--user",
    "--quiet",
    "--service-type=exec",
    `--unit=${unit}`,
    `--description=workflowd resident launch ${launchId}`,
    "--property=KillMode=control-group",
    ...Object.entries(environment).map(([key, value]) => `--setenv=${key}=${value}`),
    options.binary,
    "-c",
    subscriptionConfig,
    "app-server",
    "--listen",
    `unix://${socket}`,
  ])
  return attachAppServer({ socket, unit, launchId, invocation: null }, notify)
}

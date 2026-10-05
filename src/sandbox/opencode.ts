import type { SandboxTransport } from "./transport"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { Schema } from "effect"
import { compileSandboxBridge } from "./bridge"

export type SandboxOpenCodeInput = {
  readonly directory: string
  readonly binary: string
  readonly transport: SandboxTransport
  readonly authFile: string
  readonly providers: Readonly<Record<string, unknown>>
}

const version = "0.0.0-beta-19242"
const binaryHash = "5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c"
const Health = Schema.Struct({ healthy: Schema.Literal(true), version: Schema.Literal(version) })
const Mcp = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Struct({ status: Schema.String }),
    }),
  ),
})
const ModelCredentials = Schema.Record(
  Schema.String,
  Schema.Struct({ type: Schema.Literal("api"), key: Schema.NonEmptyString }),
)

async function command(args: ReadonlyArray<string>) {
  const child = Bun.spawn([...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Sandbox process command failed: ${stderr.slice(0, 4096)}`)
  return stdout.trim()
}

async function localPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close((error) => {
        if (error !== undefined) reject(error)
        else if (address === null || typeof address === "string")
          reject(new Error("No sandbox port"))
        else resolve(address.port)
      })
    })
  })
}

export async function startSandboxOpenCode(input: SandboxOpenCodeInput): Promise<{
  readonly url: string
  readonly password: string
  readonly unit: string
  readonly invocationId: string
  readonly close: () => Promise<void>
}> {
  for (const path of [input.directory, input.binary, input.authFile]) {
    if (!/^\/[a-zA-Z0-9/_.@-]+$/.test(path) || (await realpath(path)) !== path) {
      throw new Error("Sandbox paths must be canonical absolute paths")
    }
  }
  if (
    createHash("sha256")
      .update(await readFile(input.binary))
      .digest("hex") !== binaryHash
  ) {
    throw new Error(`Sandbox requires checksum-pinned OpenCode ${version}`)
  }
  const credentials = Schema.decodeUnknownSync(ModelCredentials)(
    JSON.parse(await readFile(input.authFile, "utf8")),
  )
  const home = join(input.directory, "home")
  const bridge = join(input.directory, "bridge")
  await compileSandboxBridge(bridge)
  // Opening the global config directory also prevents ancestor/project discovery.
  const directory = join(home, ".config/opencode")
  const auth = join(home, ".local/share/opencode/auth.json")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(join(home, ".local/share/opencode"), { recursive: true, mode: 0o700 })
  await writeFile(auth, "{}", { mode: 0o600 })
  const transportFile = join(input.directory, "transport.json")
  await writeFile(transportFile, JSON.stringify(input.transport), { mode: 0o600 })
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "execute", resource: "*", effect: "allow" },
    { action: "container-use_*", resource: "*", effect: "allow" },
  ]
  await writeFile(
    join(directory, "opencode.json"),
    JSON.stringify({
      update: "disable",
      share: "disabled",
      snapshots: false,
      formatter: false,
      lsp: false,
      permissions,
      default_agent: "sandbox",
      agents: {
        sandbox: { mode: "primary", description: "Disposable runner workspace", permissions },
      },
      providers: input.providers,
      mcp: {
        servers: {
          "container-use": {
            type: "local",
            command: [bridge, transportFile],
            timeout: { startup: 300_000, execution: 300_000, discovery: 300_000 },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  const port = await localPort()
  const password = randomBytes(32).toString("hex")
  const unit = `workflowd-sandbox-${input.transport.leaseId}`
  const url = `http://127.0.0.1:${port}`
  const close = async () => {
    await command(["systemctl", "--user", "stop", unit])
    const state = await command([
      "systemctl",
      "--user",
      "show",
      unit,
      "--property=ActiveState",
      "--value",
    ])
    if (state !== "inactive" && state !== "failed") throw new Error("Sandbox unit has not stopped")
  }
  await command([
    "systemd-run",
    "--user",
    "--collect",
    `--unit=${unit}`,
    "-p",
    "PrivateTmp=yes",
    "-p",
    "PrivateUsers=yes",
    "-p",
    "ProtectSystem=strict",
    "-p",
    "ProtectHome=tmpfs",
    "-p",
    "NoNewPrivileges=yes",
    "-p",
    "KillMode=control-group",
    "-p",
    "MemoryMax=2G",
    "-p",
    "MemorySwapMax=0",
    "-p",
    "RuntimeMaxSec=17100",
    "-p",
    `WorkingDirectory=${directory}`,
    "-p",
    `BindPaths=${input.directory}`,
    "-p",
    `BindReadOnlyPaths=${input.binary} ${bridge} ${transportFile} ${directory} ${input.transport.identityFile} ${input.transport.knownHostsFile} ${input.authFile}:${auth}`,
    "/usr/bin/env",
    "-i",
    `HOME=${home}`,
    "PATH=/usr/bin:/bin",
    "OPENCODE_DISABLE_PROJECT_CONFIG=true",
    `OPENCODE_SERVER_PASSWORD=${password}`,
    input.binary,
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ])
  try {
    const headers = {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    }
    const deadline = Date.now() + 300_000
    const location = new URLSearchParams({ "location[directory]": directory })
    for (;;) {
      const state = await command([
        "systemctl",
        "--user",
        "show",
        unit,
        "--property=ActiveState",
        "--value",
      ])
      if (state !== "active" && state !== "activating")
        throw new Error("Sandbox namespace preflight failed")
      const health = await fetch(`${url}/api/health`, {
        headers,
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined)
      if (health?.ok) {
        Schema.decodeUnknownSync(Health)(await health.json())
        const response = await fetch(`${url}/api/mcp?${location.toString()}`, {
          headers,
          signal: AbortSignal.timeout(1000),
        })
        const mcp = Schema.decodeUnknownSync(Mcp)(await response.json())
        if (
          mcp.data.some(
            (server) => server.name === "container-use" && server.status.status === "connected",
          )
        )
          break
      }
      if (Date.now() >= deadline) throw new Error("Sandbox tools did not become ready")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Fresh v2 databases do not import legacy auth.json. Use the v2 integration API;
    // the source remains read-only and only this run's private database receives keys.
    for (const provider of Object.keys(input.providers)) {
      const credential = credentials[provider]
      if (credential === undefined) throw new Error("Sandbox model credential is missing")
      const response = await fetch(
        `${url}/api/integration/${encodeURIComponent(provider)}/connect/key?${location.toString()}`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ key: credential.key }),
          signal: AbortSignal.timeout(5000),
        },
      )
      if (!response.ok) throw new Error("Sandbox model credential registration failed")
    }
    // This pinned OpenCode version debounces MCP catalog registration by 100ms.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const invocationId = await command([
      "systemctl",
      "--user",
      "show",
      unit,
      "--property=InvocationID",
      "--value",
    ])
    return { url, password, unit, invocationId, close }
  } catch (error) {
    await close()
    throw error
  }
}

import { mkdir, readFile, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AbsolutePath, Config, Session, type OpenCodeClient } from "@opencode-ai/client/effect"
import { Effect, Schedule, Schema } from "effect"
import { compileSandboxBridge } from "./bridge"
import {
  saveSandboxFile,
  bindingDirectory,
  sandboxPolicyHash,
  sandboxRules,
  readSandboxBinding,
  writeSandboxBinding,
  type SandboxSessionBinding,
} from "./binding"
import type { SandboxTransport } from "./transport"
import type { OpenCodeAdapter, OpenCodeModel } from "../opencode/adapter"

// Historical units remain in custody until their saved invocation is stopped.
export const SandboxEndpoint = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:\d+$/)),
  password: Schema.NonEmptyString,
  unit: Schema.String.check(Schema.isPattern(/^workflowd-sandbox-[a-zA-Z0-9-]{1,80}$/)),
  invocationId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
})
export type SandboxEndpoint = typeof SandboxEndpoint.Type

export async function readSandboxEndpoint(directory: string): Promise<SandboxEndpoint> {
  return Schema.decodeUnknownSync(SandboxEndpoint)(
    JSON.parse(await readFile(join(directory, "endpoint.json"), "utf8")),
  )
}

export async function stopSandboxOpenCode(
  endpoint: Pick<SandboxEndpoint, "unit" | "invocationId">,
) {
  const state = await command([
    "systemctl",
    "--user",
    "show",
    endpoint.unit,
    "-p",
    "ActiveState",
    "-p",
    "InvocationID",
  ])
  if (/^ActiveState=inactive$/m.test(state)) return
  if (!state.includes(`InvocationID=${endpoint.invocationId}`))
    throw new Error("Sandbox unit generation changed")
  await command(["systemctl", "--user", "stop", endpoint.unit])
  const after = await command(["systemctl", "--user", "show", endpoint.unit, "-p", "ActiveState"])
  if (!/^ActiveState=(inactive|failed)$/m.test(after))
    throw new Error("Sandbox unit stop unconfirmed")
  if (/^ActiveState=failed$/m.test(after))
    await command(["systemctl", "--user", "reset-failed", endpoint.unit])
}

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

export const makeSandboxOpenCode = (client: OpenCodeClient, executor: OpenCodeAdapter) => {
  const preflight = Effect.fn("SandboxOpenCode.preflight")(function* (directory: string) {
    const health = yield* client.health.get()
    if (!health.healthy || health.version !== "0.0.0-beta-19242")
      return yield* Effect.fail(new Error("Unverified sandbox executor version"))
    const location = { directory }
    const resolved = yield* client.location.get({ location })
    if (
      resolved.directory !== directory ||
      resolved.project.directory !== directory ||
      resolved.project.canonical !== directory
    )
      return yield* Effect.fail(new Error("Sandbox location is not exclusive"))
    const catalog = yield* client.agent.list({ location }).pipe(
      Effect.repeat({
        until: (catalog) => catalog.data.some((entry) => entry.id === "sandbox"),
        schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 50 })),
      }),
    )
    const agent = catalog.data.find((entry) => entry.id === "sandbox")
    if (
      agent === undefined ||
      agent.model !== undefined ||
      agent.mode !== "primary" ||
      JSON.stringify(agent.permissions.slice(-sandboxRules.length)) !== JSON.stringify(sandboxRules)
    )
      return yield* Effect.fail(new Error("Reviewed sandbox agent is unavailable"))
    return resolved.project.id
  })
  const checkSession = Effect.fn("SandboxOpenCode.checkSession")(function* (
    binding: SandboxSessionBinding,
  ) {
    const session = yield* client.session.get({ sessionID: Session.ID.make(binding.sessionId) })
    if (
      session.agent !== "sandbox" ||
      session.location.directory !== binding.directory ||
      session.projectID !== binding.locationIdentity
    )
      return yield* Effect.fail(new Error("Sandbox session binding changed"))
    return session
  })
  const check = Effect.fn("SandboxOpenCode.check")(function* (binding: SandboxSessionBinding) {
    const saved = yield* Effect.tryPromise(() => readSandboxBinding(binding.directory))
    if (
      saved.state !== "active" ||
      JSON.stringify(saved) !== JSON.stringify(binding) ||
      binding.policyHash !== sandboxPolicyHash
    )
      return yield* Effect.fail(new Error("Sandbox binding is inactive or changed"))
    if ((yield* preflight(binding.directory)) !== binding.locationIdentity)
      return yield* Effect.fail(new Error("Sandbox location changed"))
    yield* checkSession(binding)
    const catalog = yield* client.mcp.list({ location: { directory: binding.directory } })
    const bridges = catalog.data.filter((entry) => entry.name.startsWith("workflowd_sandbox_"))
    if (
      bridges.length !== 1 ||
      bridges[0]?.name !== binding.bridgeServerName ||
      bridges[0].status.status !== "connected"
    )
      return yield* Effect.fail(new Error("Sandbox bridge binding changed"))
  })
  const reserve = Effect.fn("SandboxOpenCode.reserve")(function* (directory: string) {
    yield* Effect.tryPromise(async () => {
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
      await mkdir(directory, { mode: 0o700 })
      if ((await realpath(directory)) !== directory)
        throw new Error("Sandbox location is not canonical")
    })
    const identity = yield* preflight(directory)
    const sessions = yield* client.session.list({
      directory: AbsolutePath.make(directory),
      limit: 1,
    })
    const catalog = yield* client.mcp.list({ location: { directory } })
    if (
      sessions.data.length !== 0 ||
      catalog.data.some((entry) => entry.name.startsWith("workflowd_sandbox_"))
    )
      return yield* Effect.fail(new Error("Sandbox location is already in use"))
    return identity
  })
  const start = Effect.fn("SandboxOpenCode.start")(function* (
    binding: SandboxSessionBinding,
    transport: SandboxTransport,
    model: OpenCodeModel,
  ) {
    const root = bindingDirectory(binding.directory)
    const bridge = join(root, "bridge")
    const transportFile = join(root, "transport.json")
    yield* Effect.tryPromise(async () => {
      await compileSandboxBridge(bridge)
      await saveSandboxFile(root, "transport.json", JSON.stringify(transport), true)
    })
    const session = yield* executor.createSession({
      id: binding.sessionId,
      directory: binding.directory,
      title: `workflowd ${binding.runId}`,
      agent: "sandbox",
      model,
    })
    if (session.id !== binding.sessionId)
      return yield* Effect.fail(new Error("Sandbox session reservation changed"))
    yield* checkSession(binding)
    const active = { ...binding, state: "active" as const }
    yield* Effect.tryPromise(() => writeSandboxBinding(active))
    const configuration = yield* Schema.decodeUnknownEffect(Config.Info)({
      mcp: {
        servers: {
          bridge: {
            type: "local",
            command: [bridge, transportFile, join(root, "binding.json")],
            timeout: { startup: 120000, execution: 300000 },
          },
        },
      },
    })
    const config = configuration.mcp?.servers?.bridge
    if (config === undefined) return yield* Effect.fail(new Error("Sandbox bridge config missing"))
    yield* client.mcp.add({
      location: { directory: binding.directory },
      server: binding.bridgeServerName,
      config,
    })
    // beta-19242 debounces MCP tool catalog registration by 100ms.
    yield* Effect.sleep("200 millis")
    // Confirm the location still holds exactly the owned bridge.
    yield* check(active).pipe(
      Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 50 }))),
    )
    return active
  })
  const stop = Effect.fn("SandboxOpenCode.stop")(function* (binding: SandboxSessionBinding) {
    const sessionID = Session.ID.make(binding.sessionId)
    const session = yield* client.session
      .get({ sessionID })
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(undefined)))
    if (session !== undefined) {
      yield* checkSession(binding)
      yield* client.session.interrupt({ sessionID })
      const active = yield* client.session.active()
      const inbox = yield* client.session.inbox.list({ sessionID })
      if (active[sessionID] !== undefined || inbox.length !== 0)
        return yield* Effect.fail(new Error("Sandbox session quiescence unconfirmed"))
    }
    yield* Effect.tryPromise(() => writeSandboxBinding({ ...binding, state: "revoked" }))
    yield* client.mcp
      .remove({ location: { directory: binding.directory }, server: binding.bridgeServerName })
      .pipe(Effect.catchTag("McpServerNotFoundError", () => Effect.void))
    const catalog = yield* client.mcp.list({ location: { directory: binding.directory } })
    if (catalog.data.some((entry) => entry.name === binding.bridgeServerName))
      return yield* Effect.fail(new Error("Sandbox bridge revocation unconfirmed"))
  })
  return { reserve, preflight, check, start, stop }
}

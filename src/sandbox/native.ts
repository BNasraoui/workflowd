import { codexProjectArguments } from "../execution/project-config"
import { sandboxDiagnostic } from "./diagnostics"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { RpcClient } from "../resident/rpc"
import { Schema } from "effect"
import { bindingDirectory, readSandboxBinding } from "./binding"

/** Only server names survive discovery; inherited transports and credentials stay in memory. */
const Servers = Schema.Array(Schema.Struct({ name: Schema.String }))

const Skills = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      skills: Schema.Array(Schema.Struct({ path: Schema.String })),
      errors: Schema.Array(Schema.Unknown),
    }),
  ),
})

// Ask the same CLI that will run the agent: discovery roots include user,
// project, system and configured skills, and differ between CLI versions.
async function disabledCodexSkills(binary: string, directory: string) {
  const child = Bun.spawn(
    [
      binary,
      ...codexProjectArguments(directory),
      "-c",
      "features.plugins=false",
      "-c",
      "features.apps=false",
      "app-server",
      "--listen",
      "stdio://",
    ],
    { cwd: directory, detached: true, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  )
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
    }
  }
  const rpc = new RpcClient(
    (line) => {
      child.stdin.write(line)
      void child.stdin.flush()
    },
    () => undefined,
  )
  const reader = createInterface({ input: Readable.fromWeb(child.stdout), crlfDelay: Infinity })
  reader.on("line", (line) => {
    try {
      if (Buffer.byteLength(line) > 1048576) throw new Error("Skill discovery exceeds bound")
      rpc.receive(line)
    } catch {
      rpc.close()
      child.kill("SIGKILL")
    }
  })
  void child.exited.then(() => rpc.close())
  try {
    await rpc.request("initialize", { clientInfo: { name: "workflowd-sandbox", version: "1" } })
    const result = Schema.decodeUnknownSync(Skills)(
      await rpc.request("skills/list", { cwds: [directory], forceReload: true }),
    )
    const catalog = result.data[0]
    if (result.data.length !== 1 || catalog?.cwd !== directory || catalog.errors.length !== 0)
      throw new Error("Cannot discover native sandbox skills")
    const disabled = catalog.skills.map(
      (skill) => `{path=${JSON.stringify(skill.path)},enabled=false}`,
    )
    return `skills.config=[${disabled.join(",")}]`
  } finally {
    rpc.close()
    reader.close()
    await child.stdin.end()
    stop()
    await child.exited
  }
}

export async function nativeSandboxArguments(
  kind: "codex" | "claude",
  binary: string,
  directory: string,
  bindingFile: string,
): Promise<string[]> {
  const binding = await readSandboxBinding(directory)
  const root = bindingDirectory(directory)
  if (
    bindingFile !== join(root, "binding.json") ||
    binding.state !== "active" ||
    binding.executorId !== `${kind}:local` ||
    binding.deadline <= Date.now()
  )
    throw new Error("Native sandbox binding is inactive or belongs to another executor")
  const command = join(root, "bridge")
  const args = [join(root, "transport.json"), bindingFile]
  const name = binding.bridgeServerName
  if (kind === "claude")
    return [
      "--mcp-config",
      JSON.stringify({ mcpServers: { [name]: { command, args } } }),
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      `mcp__${name}__*`,
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-chrome",
    ]
  const child = Bun.spawn(
    [
      binary,
      ...codexProjectArguments(directory),
      "-c",
      "features.plugins=false",
      "-c",
      "features.apps=false",
      "mcp",
      "list",
      "--json",
    ],
    {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
  let servers: typeof Servers.Type
  try {
    const [status, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (status !== 0)
      throw Object.assign(
        new Error("Cannot discover inherited native MCP servers"),
        sandboxDiagnostic("native.mcp", { name: "Error", message: stderr, exitCode: status }),
      )
    servers = Schema.decodeUnknownSync(Servers)(JSON.parse(output))
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
  const overrides = [
    'approval_policy="never"',
    'web_search="disabled"',
    await disabledCodexSkills(binary, directory),
    ...[
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "multi_agent",
      "browser_use",
      "computer_use",
      "image_generation",
      "view_image",
      "hooks",
      "skill_search",
    ].map((feature) => `features.${feature}=false`),
    ...servers.map((server) => `mcp_servers.${server.name}.enabled=false`),
    `mcp_servers.${name}={command=${JSON.stringify(command)},args=${JSON.stringify(args)},enabled=true,required=true,default_tools_approval_mode="approve",startup_timeout_sec=120,tool_timeout_sec=300}`,
  ]
  return [
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    ...overrides.flatMap((value) => ["-c", value]),
  ]
}

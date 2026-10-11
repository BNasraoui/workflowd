import { join } from "node:path"
import { Schema } from "effect"
import { bindingDirectory, readSandboxBinding } from "./binding"

/** Only server names survive discovery; inherited transports and credentials stay in memory. */
const Servers = Schema.Array(Schema.Struct({ name: Schema.String }))

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
    [binary, "-c", "features.plugins=false", "-c", "features.apps=false", "mcp", "list", "--json"],
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
    const [status, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (status !== 0) throw new Error("Cannot discover inherited native MCP servers")
    servers = Schema.decodeUnknownSync(Servers)(JSON.parse(output))
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
  const overrides = [
    'approval_policy="never"',
    'web_search="disabled"',
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

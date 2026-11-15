import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

test("MCP unit uses the pinned Bun and stable release entrypoint", async () => {
  const [unit, packageJson] = await Promise.all([
    readFile("deploy/systemd/workflowd-mcp.service", "utf8"),
    readFile("package.json", "utf8"),
  ])
  expect(JSON.parse(packageJson).scripts.mcp).toBe("bun src/mcp-server.ts")
  expect(unit.split("\n").filter((line) => line.startsWith("ExecStart="))).toEqual([
    "ExecStart=/opt/workflowd/bin/bun /opt/workflowd/deploy/current/src/mcp-server.ts",
  ])
  expect(unit).toContain("WorkingDirectory=/opt/workflowd/deploy/current")
})

test("shipped deployment defaults Fix Work off but permits explicit enablement", async () => {
  const [environment, unit, readme] = await Promise.all([
    readFile("deploy/workflowd.env.example", "utf8"),
    readFile("deploy/systemd/workflowd.service", "utf8"),
    readFile("README.md", "utf8"),
  ])

  expect(environment).toContain("WORKFLOWD_FIX_WORK_ENABLED=false")
  expect(environment).toContain("WORKFLOWD_TRUSTED_AGENT_USERS=trusted-agent[bot]")
  const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="))
  if (execStart === undefined) throw new Error("missing ExecStart")
  expect(execStart).toBe(
    "ExecStart=/opt/workflowd/bin/bun /opt/workflowd/deploy/current/src/main.ts",
  )
  expect(unit).not.toContain("WORKFLOWD_FIX_WORK_ENABLED=false")
  expect(readme).toContain("trusted agent-owned pull requests")
  expect(readme).toContain("WORKFLOWD_FIX_WORK_ENABLED=true")
  expect(readme).toContain("WORKFLOWD_TRUSTED_AGENT_USERS")
  expect(readme).toContain("PR author's exact GitHub login")
  expect(readme).toContain("same-repository branch remains review-only")
})

test("remote runner ships as a hardened long-running systemd command", async () => {
  const [unit, packageJson, guide, processSource] = await Promise.all([
    readFile("deploy/systemd/workflowd-runner.service", "utf8"),
    readFile("package.json", "utf8"),
    readFile("docs/remote-runner.md", "utf8"),
    readFile("src/remote-process.ts", "utf8"),
  ])
  expect(JSON.parse(packageJson).scripts.runner).toBe("bun src/remote-runner.ts")
  expect(unit).toContain(
    "ExecStart=/opt/workflowd/bin/bun /opt/workflowd/deploy/current/src/remote-runner.ts",
  )
  expect(unit).toContain("LoadCredential=nats-token:")
  expect(unit).toContain("NoNewPrivileges=true")
  expect(unit).toContain("ProtectSystem=strict")
  expect(unit).toContain("PrivateTmp=true")
  expect(guide).toContain("Tailscale")
  expect(guide).toContain("JetStream")
  expect(guide).not.toContain("exactly-once")
  expect(processSource).toContain("runRemoteRunnerLoop")
  expect(processSource).not.toContain("Effect.forever")
})

test("an OpenCode restart cannot stop workflowd: its units are wanted, never required", async () => {
  const directory = "deploy/systemd/workflowd.service.d"
  const units = await Promise.all(
    [
      "deploy/systemd/workflowd.service",
      ...(await readdir(directory).catch(() => [])).map((name) => join(directory, name)),
    ].map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  )
  const directives = units.flatMap(({ path, text }) =>
    text
      .split("\n")
      .filter((line) => /^(Requires|BindsTo|Requisite|PartOf)=/.test(line))
      .map((line) => `${path}: ${line}`),
  )
  expect(directives.filter((line) => /opencode/.test(line))).toEqual([])
  const lines = units.flatMap(({ text }) => text.split("\n"))
  for (const unit of ["opencode-server.service", "opencode2-server.service"]) {
    expect(lines.some((line) => /^Wants=/.test(line) && line.includes(unit))).toBe(true)
    expect(lines.some((line) => /^After=/.test(line) && line.includes(unit))).toBe(true)
  }
})

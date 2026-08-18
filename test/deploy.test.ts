import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

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
  expect(execStart).toBe("ExecStart=%h/.bun/bin/bun run start")
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
  expect(unit).toContain("ExecStart=%h/.bun/bin/bun run runner")
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

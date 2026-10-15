import { mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owner } from "./owner"
import { type Config, dockerBackend, systemdBackend } from "./backend"
import { finish } from "./guard"
import { reap } from "./reaper"

const originalPath = process.env.WORKFLOWD_TEST_ORIGINAL_PATH ?? process.env.PATH ?? ""
const directory = mkdtempSync(join(tmpdir(), "workflowd-test-run-"))
const config: Config = {
  owner: owner(),
  launcher: owner(),
  directory,
  docker: Bun.which("docker", { PATH: originalPath }),
  systemdRun: Bun.which("systemd-run", { PATH: originalPath }),
  systemctl: Bun.which("systemctl", { PATH: originalPath }),
  env: { ...process.env, PATH: originalPath },
}
const configPath = join(directory, "config.json")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
for (const [name, binary] of [
  ["docker", config.docker],
  ["systemd-run", config.systemdRun],
]) {
  if (!binary) continue
  writeFileSync(
    join(directory, name!),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "proxy.ts"))} ${quote(configPath)} ${name} "$@"\n`,
    { mode: 0o700 },
  )
}
// Optional backends may be absent in pure unit suites. Once a backend is used,
// an inventory failure makes teardown fail rather than claiming no resources.
for (const backend of [
  ...(config.docker && !process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
    ? [dockerBackend(config)]
    : []),
  ...(config.systemctl
    ? [
        systemdBackend(config, true),
        ...(process.getuid!() === 0 ? [systemdBackend(config, false)] : []),
      ]
    : []),
]) {
  try {
    backend.list()
  } catch {
    continue
  }
  reap(backend)
}
writeFileSync(`${configPath}.next`, JSON.stringify(config), { mode: 0o600 })
renameSync(`${configPath}.next`, configPath)
const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
  env: {
    ...process.env,
    PATH: `${directory}:${originalPath}`,
    WORKFLOWD_TEST_ORIGINAL_PATH: originalPath,
    WORKFLOWD_TEST_RESOURCE_CONFIG: configPath,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
config.owner = owner(child.pid)
writeFileSync(`${configPath}.next`, JSON.stringify(config), { mode: 0o600 })
renameSync(`${configPath}.next`, configPath)
const guardian = Bun.spawn([process.execPath, join(import.meta.dir, "guardian.ts"), configPath], {
  env: config.env,
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
})
writeFileSync(join(directory, "guardian"), String(guardian.pid))
guardian.unref()
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => child.kill(signal))
let status = await child.exited
try {
  finish(config)
} catch (error) {
  console.error(String(error))
  status = 1
}
process.exit(status)

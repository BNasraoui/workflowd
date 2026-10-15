import { existsSync, unlinkSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { owner } from "./owner"
import { type Config, dockerBackend, systemdBackend } from "./backend"
import { finish } from "./guard"
import { reap } from "./reaper"

const originalPath = process.env.WORKFLOWD_TEST_ORIGINAL_PATH ?? process.env.PATH ?? ""
const candidate = process.env.WORKFLOWD_TEST_RESOURCE_CONFIG
const inherited =
  candidate && existsSync(join(dirname(candidate), "bootstrap")) ? candidate : undefined
if (inherited) unlinkSync(join(dirname(inherited), "bootstrap"))
const directory = inherited
  ? dirname(inherited)
  : mkdtempSync(join(tmpdir(), "workflowd-test-run-"))
delete process.env.WORKFLOWD_TEST_RESOURCE_CONFIG
const previous: Config | undefined = inherited
  ? JSON.parse(readFileSync(inherited, "utf8"))
  : undefined
const config: Config = {
  owner: owner(),
  launcher: previous?.owner ?? owner(),
  directory,
  docker: Bun.which("docker", { PATH: originalPath }),
  systemdRun: Bun.which("systemd-run", { PATH: originalPath }),
  systemctl: Bun.which("systemctl", { PATH: originalPath }),
  env: { ...process.env, PATH: originalPath },
}
const configPath = join(directory, "config.json")
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
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
if (!inherited) {
  writeFileSync(join(directory, "bootstrap"), "")
  const child = Bun.spawn(
    [
      process.execPath,
      ...readFileSync("/proc/self/cmdline", "utf8").split("\0").slice(1).filter(Boolean),
    ],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${originalPath}`,
        WORKFLOWD_TEST_ORIGINAL_PATH: originalPath,
        WORKFLOWD_TEST_RESOURCE_CONFIG: configPath,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => child.kill(signal))
  let status = await child.exited
  try {
    if (existsSync(configPath)) {
      const completed: Config = JSON.parse(readFileSync(configPath, "utf8"))
      finish(completed)
    }
  } catch (error) {
    console.error(String(error))
    status = 1
  }
  // Bun ignores process.exitCode changes made by an exit listener. The launcher
  // checks the durable failure marker before returning the suite's exit status.
  process.exit(existsSync(join(directory, "failure")) ? 1 : status)
}
// An unavailable optional backend must not break suites which do not use it. Once used,
// inventory failures are fatal; no successful suite can hide an unverifiable cleanup.
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
process.env.WORKFLOWD_TEST_ORIGINAL_PATH = originalPath
process.env.PATH = `${directory}:${originalPath}`
const guardian = Bun.spawn([process.execPath, join(import.meta.dir, "guardian.ts"), configPath], {
  env: config.env,
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
})
writeFileSync(join(directory, "guardian"), String(guardian.pid))
guardian.unref()
process.once("exit", () => {
  try {
    finish(config)
  } catch (error) {
    console.error(String(error))
    writeFileSync(join(directory, "failure"), String(error))
  }
})
for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const)
  process.once(signal, () => process.exit(code))

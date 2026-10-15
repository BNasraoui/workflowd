import { existsSync } from "node:fs"
import { join } from "node:path"
import { command, type Config, unitLabel } from "./backend"

export async function startGuardian(config: Config, configPath: string) {
  const args = [process.execPath, join(import.meta.dir, "guardian.ts"), configPath]
  try {
    if (!config.systemdRun) throw new Error("systemd-run unavailable")
    command(config, [
      config.systemdRun,
      "--user",
      "--quiet",
      "--collect",
      "--service-type=exec",
      `--setenv=${unitLabel}=${config.launcher}`,
      `--unit=workflowd-test-guardian-${crypto.randomUUID()}`,
      ...args,
    ])
  } catch (error) {
    console.warn(
      `Independent test guardian unavailable; whole-cgroup death requires the next startup sweep: ${String(error)}`,
    )
    const guardian = Bun.spawn(args, {
      env: config.env,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    })
    guardian.unref()
  }
  // Tests can kill the guardian deliberately only after it has registered itself.
  const deadline = Date.now() + 5000
  while (existsSync(config.directory) && !existsSync(join(config.directory, "guardian"))) {
    if (Date.now() > deadline) throw new Error("Test guardian failed to register")
    await Bun.sleep(10)
  }
}

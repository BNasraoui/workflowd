import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { command, type Config, unitLabel } from "./backend"
import { owner, ownerState } from "./owner"

const dropin = "/run/systemd/system/workflowd-native-.service.d/90-workflowd-test.conf"

/** Only the disposable two-UID CI fixture installs units or launches through an absolute systemd-run path. */
export function labelNativeTestUnits(directory = process.env.PATH!.split(":")[0]!, path = dropin) {
  if (
    path === dropin &&
    (process.getuid!() !== 0 || process.env.WORKFLOWD_AGENT_DEPLOYED_TEST !== "1")
  )
    throw new Error("Native test unit labels require the disposable CI VM")
  if (!directory.includes("workflowd-test-run-")) throw new Error("Test resource guard required")
  writeFileSync(join(directory, "used-system"), "")
  mkdirSync(dirname(path), { recursive: true })
  try {
    const prior = readFileSync(path, "utf8")
    const priorOwner = /^\[Service\]\nEnvironment=WORKFLOWD_TEST_RESOURCE_RUN=(v1\.[^\n]+)\n$/.exec(
      prior,
    )?.[1]
    if (ownerState(priorOwner) === "dead") rmSync(path)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  const contents = `[Service]\nEnvironment=${unitLabel}=${owner()}\n`
  writeFileSync(path, contents, { flag: "wx" })
  return `Environment=${unitLabel}=${owner()}\n`
}

export function removeNativeTestLabels(config: Config, path = dropin) {
  if (
    path === dropin &&
    (config.env.WORKFLOWD_AGENT_DEPLOYED_TEST !== "1" || process.getuid!() !== 0)
  )
    return
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return
  }
  if (contents !== `[Service]\nEnvironment=${unitLabel}=${config.owner}\n`) return
  rmSync(path)
  command(config, [config.systemctl!, "daemon-reload"])
}

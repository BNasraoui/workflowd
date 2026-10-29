import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Config, label, unitLabel } from "./backend"
import { containerArgs } from "./docker"
import { owner, ownerState } from "./owner"

const config: Config = await Bun.file(process.argv[2]!).json()
const kind = process.argv[3]
const args = process.argv.slice(4)
if (existsSync(join(config.directory, "closing")) || ownerState(config.owner) !== "alive")
  throw new Error("Test run ended; refusing resource command")
const pending = join(config.directory, `pending-${process.pid}`)
writeFileSync(pending, owner())
try {
  let binary: string
  if (kind === "systemd-run") {
    binary = config.systemdRun!
    if (args.includes("--scope") || args.some((arg) => /^--(host|machine)(=|$)/.test(arg)))
      throw new Error("Test resource guard supports local service units only")
    writeFileSync(join(config.directory, args.includes("--user") ? "used-user" : "used-system"), "")
    args.unshift(`--setenv=${unitLabel}=${config.owner}`)
  } else {
    binary = config.docker!
    // Host PID liveness has no meaning on a remote engine.
    if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || args[0]?.startsWith("-"))
      throw new Error("Test resource guard requires the local default Docker engine")
    writeFileSync(join(config.directory, "used-docker"), "")
    const index = ["container", "network", "volume"].includes(args[0]!) ? 1 : 0
    if (args.some((arg) => arg.startsWith(`${label}=`))) throw new Error("Reserved test run label")
    if (["run", "create"].includes(args[index]!))
      args.splice(index + 1, 0, "--label", `${label}=${config.owner}`)
    if (["run", "create"].includes(args[index]!) && (index === 0 || args[0] === "container"))
      containerArgs(config, args)
    // The integrated BuildKit driver creates no host intermediate containers. Never
    // allow legacy builds or a docker-container buildx driver to escape ownership.
    if (args[0] === "build") {
      process.env.DOCKER_BUILDKIT = "1"
      process.env.BUILDX_BUILDER = "default"
    }
  }
  if (existsSync(join(config.directory, "closing")) || ownerState(config.owner) !== "alive")
    throw new Error("Test run ended during resource preparation")
  const child = Bun.spawn(
    [binary, ...(kind === "docker" ? ["--context", "default"] : []), ...args],
    {
      env: { ...process.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  process.exitCode = await child.exited
} finally {
  rmSync(pending, { force: true })
}

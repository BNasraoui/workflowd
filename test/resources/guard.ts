import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ownerState } from "./owner"
import { type Config, dockerBackend, systemdBackend } from "./backend"
import { reap } from "./reaper"

export function cleanup(config: Config, own?: string) {
  const failures: unknown[] = []
  // Only a backend used by this run is required at exit. Startup probes are handled separately.
  for (const kind of readdirSync(config.directory).filter((name) => name.startsWith("used-"))) {
    try {
      const backend =
        kind === "used-docker"
          ? dockerBackend(config)
          : systemdBackend(config, kind === "used-user")
      reap(backend, own)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"))
}

export function finish(config: Config) {
  if (!existsSync(config.directory)) return
  writeFileSync(join(config.directory, "closing"), "")
  cleanup(config, config.owner)
  if (
    readdirSync(config.directory).some(
      (name) =>
        name.startsWith("pending-") &&
        ownerState(readFileSync(join(config.directory, name), "utf8")) === "alive",
    )
  )
    throw new Error("Test resource commands still running at teardown")
  rmSync(config.directory, { recursive: true, force: true })
}

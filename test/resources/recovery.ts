import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownerState } from "./owner"

/** Only local, labelled recovery directories with no surviving owner or command. */
export function sweepDirectories() {
  for (const name of readdirSync(tmpdir()).filter((name) =>
    name.startsWith("workflowd-test-run-"),
  )) {
    const directory = join(tmpdir(), name)
    try {
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || stat.uid !== process.getuid!()) continue
      const config: { owner?: string; launcher?: string; directory?: string } = JSON.parse(
        readFileSync(join(directory, "config.json"), "utf8"),
      )
      if (
        config.directory !== directory ||
        ownerState(config.owner) !== "dead" ||
        ownerState(config.launcher) !== "dead"
      )
        continue
      if (
        readdirSync(directory).some(
          (name) =>
            name.startsWith("pending-") &&
            ownerState(readFileSync(join(directory, name), "utf8")) !== "dead",
        )
      )
        continue
      rmSync(directory, { recursive: true })
    } catch {
      // Missing, unreadable or malformed ownership is never deletion authority.
    }
  }
}

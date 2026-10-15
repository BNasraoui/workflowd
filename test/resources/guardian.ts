import { existsSync } from "node:fs"
import type { Config } from "./backend"
import { ownerState } from "./owner"
import { finish } from "./guard"

const config: Config = await Bun.file(process.argv[2]!).json()
while (
  (ownerState(config.owner) === "alive" || ownerState(config.launcher) === "alive") &&
  existsSync(config.directory)
)
  await Bun.sleep(500)
if (existsSync(config.directory)) {
  // Keep retrying while an in-flight CLI request settles. The closing marker
  // fences new launches, including ones which were pulling an image at exit.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      finish(config)
      break
    } catch (error) {
      if (attempt === 59) {
        console.error(String(error))
        process.exitCode = 1
      }
    }
    await Bun.sleep(1000)
  }
}

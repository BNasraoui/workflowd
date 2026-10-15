import { existsSync } from "node:fs"
import type { Config } from "./backend"
import { ownerState } from "./owner"
import { finish } from "./guard"

const config: Config = await Bun.file(process.argv[2]!).json()
while (existsSync(config.directory)) {
  const states = [ownerState(config.owner), ownerState(config.launcher)]
  if (states.includes("unknown"))
    throw new Error("Cannot verify test owner liveness; preserving resources")
  if (states.every((state) => state === "dead")) break
  await Bun.sleep(500)
}
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

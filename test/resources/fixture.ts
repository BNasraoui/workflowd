import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Config, dockerBackend } from "./backend"
import { reap } from "./reaper"

export const fixtureLabel = "io.workflowd.test-fixture"

export function fixtureArgs(fixture: string, args: string[]): string[] {
  const index = ["container", "network", "volume"].includes(args[0]!) ? 1 : 0
  if (["run", "create"].includes(args[index]!))
    args.splice(index + 1, 0, "--label", `${fixtureLabel}=${fixture}`)
  return args
}

export function cleanupFixture(fixture: string) {
  const directory = process.env.PATH!.split(":")[0]!
  const config: Config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"))
  reap(dockerBackend(config, `${fixtureLabel}=${fixture}`), config.owner)
}

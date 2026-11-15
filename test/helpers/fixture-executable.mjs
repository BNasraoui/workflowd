import { execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"

export function fixtureExecutable(name) {
  const binary =
    process.env[`WORKFLOWD_FIXTURE_${name.toUpperCase()}`] ??
    execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim()
  accessSync(binary, constants.X_OK)
  return binary
}

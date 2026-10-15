import { expect, test } from "bun:test"
import { cleanupFixture, fixtureArgs } from "./fixture"

const docker = (...args: string[]) => {
  const result = Bun.spawnSync(["docker", ...args])
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test("fixture teardown removes its network and volumes without touching another active fixture", () => {
  const first = `workflowd-test-${crypto.randomUUID()}`
  const second = `workflowd-test-${crypto.randomUUID()}`
  try {
    docker(...fixtureArgs(first, ["network", "create", first]))
    docker(...fixtureArgs(first, ["volume", "create", first]))
    docker(...fixtureArgs(second, ["volume", "create", second]))
    cleanupFixture(first)
    expect(docker("volume", "ls", "--quiet", "--filter", `name=${first}`)).toBe("")
    expect(docker("network", "ls", "--quiet", "--filter", `name=${first}`)).toBe("")
    expect(docker("volume", "ls", "--quiet", "--filter", `name=${second}`)).toBe(second)
    cleanupFixture(first)
  } finally {
    cleanupFixture(first)
    cleanupFixture(second)
  }
}, 30000)

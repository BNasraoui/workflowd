import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("shipped deployment defaults Fix Work off but permits explicit enablement", async () => {
  const [environment, unit, readme] = await Promise.all([
    readFile("deploy/workflowd.env.example", "utf8"),
    readFile("deploy/systemd/workflowd.service", "utf8"),
    readFile("README.md", "utf8"),
  ])

  expect(environment).toContain("WORKFLOWD_FIX_WORK_ENABLED=false")
  const execStart = unit
    .split("\n")
    .find((line) => line.startsWith("ExecStart="))
  if (execStart === undefined) throw new Error("missing ExecStart")
  expect(execStart).toBe("ExecStart=%h/.bun/bin/bun run start")
  expect(unit).not.toContain("WORKFLOWD_FIX_WORK_ENABLED=false")
  expect(readme).toContain("trusted agent-owned pull requests")
  expect(readme).toContain("WORKFLOWD_FIX_WORK_ENABLED=true")
})

import { describe, expect, test } from "bun:test"

const trackedPaths = Bun.spawnSync([
  "git",
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "--deduplicate",
  "-z",
])
  .stdout.toString()
  .split("\0")
  .filter((path) => path !== "" && !path.startsWith(".beads/"))
  .sort()

describe("product identity", () => {
  test("tracked product files contain no superseded identifiers", async () => {
    const forbiddenIdentifiers = [
      ["opencode", "hooks"].join("-"),
      ["OPENCODE", "HOOKS"].join("_"),
      ["OpenCode", "Hooks", "Job"].join("-"),
    ]
    const violations: Array<string> = []

    for (const path of trackedPaths) {
      const file = Bun.file(path)
      if (!(await file.exists())) continue
      const content = await file.text()
      for (const identifier of forbiddenIdentifiers) {
        if (path.includes(identifier) || content.includes(identifier)) {
          violations.push(`${path}: ${identifier}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

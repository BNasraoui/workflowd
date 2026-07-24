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

describe("pull-request workflows", () => {
  test("blocking jobs check out the exact reviewed head", async () => {
    const blockingJobs = [
      [".github/workflows/ci.yml", "quality"],
      [".github/workflows/ci.yml", "repository-validation"],
      [".github/workflows/ci.yml", "deployment-validation"],
      [".github/workflows/ci.yml", "tests"],
      [".github/workflows/codeql.yml", "analyze"],
    ] as const
    const exactHeadRef = "ref: ${{ github.event.pull_request.head.sha || github.sha }}"

    for (const [path, job] of blockingJobs) {
      const workflow = await Bun.file(path).text()
      const section = workflow.match(
        new RegExp(`^  ${job}:\\n[\\s\\S]*?(?=^  \\S|(?![\\s\\S]))`, "m"),
      )?.[0]

      expect(section, `${path}: ${job}`).toContain(exactHeadRef)
    }
  })
})

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateCrapEntries } from "../scripts/crap-report"

describe("crap report generation", () => {
  test("joins coverage and complexity into sorted entries for a fixture repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "crap-fixture-"))
    const previousCwd = process.cwd()
    try {
      mkdirSync(join(dir, "src"), { recursive: true })
      mkdirSync(join(dir, "coverage"), { recursive: true })
      writeFileSync(
        join(dir, "src", "one.ts"),
        "export function scaled(input: number): number {\n  if (input > 0) return input * 2\n  return 0\n}\n",
      )
      writeFileSync(
        join(dir, "coverage", "lcov.info"),
        "SF:src/one.ts\nDA:1,3\nDA:2,3\nDA:3,0\nDA:4,0\nend_of_record\n",
      )
      const entries = generateCrapEntries(dir)
      expect(entries.length).toBe(1)
      expect(entries[0]?.name).toBe("scaled")
      expect(entries[0]?.module).toBe("one")
      expect(entries[0]?.crap).toBeGreaterThan(0)
    } finally {
      process.chdir(previousCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

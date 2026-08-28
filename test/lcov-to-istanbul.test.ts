import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lcovToIstanbul, parseLcov } from "../scripts/lcov-to-istanbul"

describe("lcov to istanbul", () => {
  test("converts SF/DA records into statement maps under absolute keys", () => {
    const lcov = [
      "TN:",
      "SF:src/a.ts",
      "DA:1,5",
      "DA:2,0",
      "DA:3,2",
      "end_of_record",
      "SF:src/b.ts",
      "DA:7,1",
      "end_of_record",
      "",
    ].join("\n")
    const files = parseLcov(lcov, "/repo")
    expect(Object.keys(files)).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"])
    const a = files["/repo/src/a.ts"]
    expect(Object.keys(a?.statementMap ?? {})).toEqual(["0", "1", "2"])
    expect(a?.s).toEqual({ 0: 5, 1: 0, 2: 2 })
    expect(files["/repo/src/b.ts"]?.s).toEqual({ 0: 1 })
  })

  test("merges duplicate SF records and skips malformed DA lines", () => {
    const lcov = [
      "SF:src/a.ts",
      "DA:1,1",
      "end_of_record",
      "SF:src/a.ts",
      "DA:2,not-a-number",
      "DA:2,3",
      "end_of_record",
    ].join("\n")
    const files = parseLcov(lcov, "/repo")
    expect(Object.keys(files)).toEqual(["/repo/src/a.ts"])
    expect(files["/repo/src/a.ts"]?.s).toEqual({ 0: 1, 1: 3 })
  })

  test("round-trips through coverage-final.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "crap-lcov-"))
    try {
      mkdirSync(join(dir, "coverage"), { recursive: true })
      writeFileSync(join(dir, "coverage", "lcov.info"), "SF:src/a.ts\nDA:1,2\nend_of_record\n")
      const outPath = lcovToIstanbul(dir)
      const key = join(dir, "src/a.ts")
      expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({
        [key]: {
          path: key,
          statementMap: {
            0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
          },
          s: { 0: 2 },
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails with guidance when coverage has not been generated", () => {
    const dir = mkdtempSync(join(tmpdir(), "crap-lcov-"))
    try {
      expect(() => lcovToIstanbul(dir)).toThrow("bun run test:coverage")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

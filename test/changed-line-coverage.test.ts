import { describe, expect, test } from "bun:test"
import {
  buildExactDiffArguments,
  evaluateChangedLineCoverage,
  parseChangedLines,
  parseLcov,
} from "../scripts/check-changed-line-coverage"

describe("changed-line coverage", () => {
  test("parses destination lines from exact zero-context diff hunks", () => {
    const changed = parseChangedLines(`diff --git a/src/a.ts b/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-old
+new
+added
@@ -8,2 +9 @@
-old
-old
+replacement
`)

    expect(changed.get("src/a.ts")).toEqual(new Set([1, 2, 9]))
  })

  test("parses and combines Bun LCOV line hits", () => {
    const coverage = parseLcov(`TN:
SF:src/a.ts
DA:1,0
DA:2,1,checksum
end_of_record
SF:src/a.ts
DA:1,2
end_of_record
`)

    expect(coverage.get("src/a.ts")).toEqual(
      new Map([
        [1, 2],
        [2, 1],
      ]),
    )
  })

  test("passes exactly 80% and reports uncovered changed executable lines", () => {
    const changed = new Map([["src/a.ts", new Set([1, 2, 3, 4, 5, 6])]])
    const coverage = new Map([
      [
        "src/a.ts",
        new Map([
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
          [5, 0],
        ]),
      ],
    ])

    expect(evaluateChangedLineCoverage(changed, coverage)).toEqual({
      passed: true,
      covered: 4,
      total: 5,
      uncovered: ["src/a.ts:5"],
      missingFiles: [],
    })
  })

  test("fails below 80% and when an eligible changed source file is absent from LCOV", () => {
    const below = evaluateChangedLineCoverage(
      new Map([["src/a.ts", new Set([1, 2, 3, 4])]]),
      new Map([
        [
          "src/a.ts",
          new Map([
            [1, 1],
            [2, 1],
            [3, 1],
            [4, 0],
          ]),
        ],
      ]),
    )
    expect(below.passed).toBe(false)

    const missing = evaluateChangedLineCoverage(new Map([["src/new.ts", new Set([1])]]), new Map())
    expect(missing).toMatchObject({ passed: false, missingFiles: ["src/new.ts"] })
  })

  test("uses separate base and head endpoints rather than merge-base syntax", () => {
    const base = "a".repeat(40)
    const head = "b".repeat(40)
    const arguments_ = buildExactDiffArguments(base, head)

    expect(arguments_).toContain(base)
    expect(arguments_).toContain(head)
    expect(arguments_.join(" ")).not.toContain("...")
  })
})

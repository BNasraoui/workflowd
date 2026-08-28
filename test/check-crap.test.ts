import { describe, expect, test } from "bun:test"
import type { CrapEntry } from "@sebassdc/crap4ts"
import { crapBaselineTolerance, evaluateCrapBaseline } from "../scripts/check-crap"

function entry(module: string, name: string, crap: number): CrapEntry {
  return { name, module, complexity: 10, coverage: 50, crap }
}

describe("crap baseline", () => {
  test("passes when no function reaches the threshold", () => {
    const entries = [entry("config", "loadConfig", 29.9)]
    expect(evaluateCrapBaseline(entries, {})).toEqual([])
  })

  test("fails a new function crossing the threshold", () => {
    const entries = [entry("http", "routeRequest", 31)]
    const violations = evaluateCrapBaseline(entries, {})
    expect(violations).toEqual([{ key: "http.routeRequest", current: 31, reason: "new" }])
  })

  test("grandfathers baseline entries within tolerance", () => {
    const entries = [entry("config", "loadConfig", 34.5)]
    const baseline = { "config.loadConfig": 34 }
    expect(evaluateCrapBaseline(entries, baseline)).toEqual([])
  })

  test("fails a baseline entry that worsens beyond tolerance", () => {
    const entries = [entry("config", "loadConfig", 34 + crapBaselineTolerance + 1)]
    const baseline = { "config.loadConfig": 34 }
    expect(evaluateCrapBaseline(entries, baseline)).toEqual([
      {
        key: "config.loadConfig",
        current: 36,
        baseline: 34,
        reason: "worsened",
      },
    ])
  })

  test("passes an improved baseline entry without pruning it", () => {
    const entries = [entry("config", "loadConfig", 20)]
    const baseline = { "config.loadConfig": 34 }
    expect(evaluateCrapBaseline(entries, baseline)).toEqual([])
  })

  test("sorts violations by score descending", () => {
    const entries = [entry("http", "routeRequest", 40), entry("config", "loadConfig", 36)]
    const violations = evaluateCrapBaseline(entries, {
      "config.loadConfig": 34,
    })
    expect(violations.map((violation) => violation.key)).toEqual([
      "http.routeRequest",
      "config.loadConfig",
    ])
  })
})

import { describe, expect, test } from "bun:test"
import type { CrapEntry } from "@sebassdc/crap4ts"
import { findCrapViolations, reportCrapViolations } from "../scripts/check-crap"

function entry(module: string, name: string, crap: number): CrapEntry {
  return { name, module, complexity: 10, coverage: 50, crap }
}

describe("crap gate", () => {
  test("passes when every function is below the threshold", () => {
    const entries = [entry("config", "loadConfig", 29.9)]
    expect(findCrapViolations(entries)).toEqual([])
  })

  test("fails a function exactly at the threshold", () => {
    const entries = [entry("config", "loadConfig", 30)]
    expect(findCrapViolations(entries)).toEqual([{ key: "config.loadConfig", crap: 30 }])
  })

  test("reports every violating function", () => {
    const entries = [
      entry("config", "loadConfig", 34),
      entry("http", "workflowStartStatus", 36.8),
      entry("qrspi.workflow-start", "toWorkflowStartValidationError", 54.2),
    ]
    const violations = findCrapViolations(entries)
    expect(violations.map((violation) => violation.key)).toEqual([
      "qrspi.workflow-start.toWorkflowStartValidationError",
      "http.workflowStartStatus",
      "config.loadConfig",
    ])
  })

  test("renders one line per violation plus remediation guidance", () => {
    const lines = reportCrapViolations([{ key: "config.loadConfig", crap: 34 }])
    expect(lines).toEqual([
      "crap: config.loadConfig scores CRAP 34.0 (threshold 30)",
      "crap: split the function or cover its branches until it scores below CRAP 30",
    ])
  })
})

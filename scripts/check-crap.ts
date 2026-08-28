// Hard gate for the CRAP report: any function in src/ at or above the risk
// threshold fails the check. Split the function or cover its branches until it
// scores below the threshold.
import type { CrapEntry } from "@sebassdc/crap4ts"
import { resolve } from "node:path"
import { crapKey, generateCrapEntries, highRiskThreshold } from "./crap-report"

export interface CrapViolation {
  key: string
  crap: number
}

export function findCrapViolations(entries: CrapEntry[]): CrapViolation[] {
  return entries
    .filter((entry) => entry.crap >= highRiskThreshold)
    .sort((left, right) => right.crap - left.crap)
    .map((entry) => ({ key: crapKey(entry), crap: entry.crap }))
}

export function reportCrapViolations(violations: CrapViolation[]): string[] {
  const lines = violations.map(
    (violation) =>
      `crap: ${violation.key} scores CRAP ${violation.crap.toFixed(1)}` +
      ` (threshold ${highRiskThreshold})`,
  )
  lines.push(
    `crap: split the function or cover its branches until it scores below ` +
      `CRAP ${highRiskThreshold}`,
  )
  return lines
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, "..")
  const violations = findCrapViolations(generateCrapEntries(repoRoot))
  if (violations.length === 0) {
    console.log(`crap: all functions below CRAP ${highRiskThreshold}`)
    return
  }
  for (const line of reportCrapViolations(violations)) console.error(line)
  process.exitCode = 1
}

if (import.meta.main) main()

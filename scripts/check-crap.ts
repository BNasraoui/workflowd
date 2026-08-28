// Ratchet gate for the CRAP report: functions already at or above the risk
// threshold are grandfathered in crap-baseline.json; anything new crossing the
// threshold, or any baseline function that gets worse, fails the check. Pay
// down debt, then regenerate the baseline deliberately with
// `bun run crap:baseline`.
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { CrapEntry } from "@sebassdc/crap4ts"
import { crapKey, generateCrapEntries, highRiskThreshold } from "./crap-report"

export type CrapBaseline = Record<string, number>

export const crapBaselineTolerance = 1

export interface CrapViolation {
  key: string
  current: number
  baseline?: number
  reason: "new" | "worsened"
}

export function evaluateCrapBaseline(
  entries: CrapEntry[],
  baseline: CrapBaseline,
): CrapViolation[] {
  const violations: CrapViolation[] = []
  for (const entry of entries) {
    if (entry.crap < highRiskThreshold) continue
    const key = crapKey(entry)
    const recorded = baseline[key]
    if (recorded === undefined) {
      violations.push({ key, current: entry.crap, reason: "new" })
      continue
    }
    if (entry.crap > recorded + crapBaselineTolerance) {
      violations.push({
        key,
        current: entry.crap,
        baseline: recorded,
        reason: "worsened",
      })
    }
  }
  return violations.sort((a, b) => b.current - a.current)
}

function isCrapBaseline(value: unknown): value is CrapBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((score) => typeof score === "number" && Number.isFinite(score))
}

function loadBaseline(baselinePath: string): CrapBaseline {
  const parsed: unknown = JSON.parse(readFileSync(baselinePath, "utf8"))
  if (!isCrapBaseline(parsed)) {
    throw new Error(
      `Invalid CRAP baseline at ${baselinePath}; regenerate with \`bun run crap:baseline\``,
    )
  }
  return parsed
}

function writeBaseline(baselinePath: string, entries: CrapEntry[]): void {
  const baseline: CrapBaseline = Object.fromEntries(
    entries
      .filter((entry) => entry.crap >= highRiskThreshold)
      .map((entry) => [crapKey(entry), Number(entry.crap.toFixed(1))] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  )
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n")
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, "..")
  const baselinePath = resolve(repoRoot, "crap-baseline.json")
  const entries = generateCrapEntries(repoRoot)
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(baselinePath, entries)
    const count = Object.keys(loadBaseline(baselinePath)).length
    console.log(`crap: wrote ${count} baseline entries to ${baselinePath}`)
    return
  }
  const violations = evaluateCrapBaseline(entries, loadBaseline(baselinePath))
  if (violations.length === 0) {
    console.log(`crap: no new or worsened functions at CRAP >= ${highRiskThreshold}`)
    return
  }
  for (const violation of violations) {
    if (violation.reason === "new") {
      console.error(
        `crap: ${violation.key} entered at CRAP ${violation.current.toFixed(1)}` +
          ` (threshold ${highRiskThreshold})`,
      )
      continue
    }
    console.error(
      `crap: ${violation.key} worsened to CRAP ${violation.current.toFixed(1)}` +
        ` (baseline ${violation.baseline?.toFixed(1)})`,
    )
  }
  console.error(
    "crap: fix the regression, or refresh the baseline with `bun run crap:baseline`" +
      " if the debt is accepted",
  )
  process.exitCode = 1
}

if (import.meta.main) main()

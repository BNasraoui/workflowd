// CRAP report (Change Risk Anti-Patterns) over src/, using @sebassdc/crap4ts.
// Reads the coverage already produced by `bun run test:coverage` (compose the
// two when you want fresh scores) and prints every analyzed function sorted by
// CRAP score. Note: crap4ts uses the cubed formula (CC^2 * (1 - cov)^3 + CC)
// and Bun coverage is line-based, so scores are an approximation, not classic
// Savoia CRAP.
import { generateReport, formatReport } from "@sebassdc/crap4ts"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { lcovToIstanbul } from "./lcov-to-istanbul"

const highRiskThreshold = 30

function main(): void {
  const repoRoot = resolve(import.meta.dir, "..")
  process.chdir(repoRoot)
  const lcovPath = resolve(repoRoot, "coverage", "lcov.info")
  lcovToIstanbul(repoRoot)
  const { entries } = generateReport({
    srcDir: resolve(repoRoot, "src"),
    coverageDir: resolve(repoRoot, "coverage"),
  })
  console.log(formatReport(entries))
  const risky = entries.filter((entry) => entry.crap >= highRiskThreshold)
  console.log(
    `${risky.length} of ${entries.length} functions at CRAP >= ${highRiskThreshold}` +
      ` (coverage from ${lcovPath}, written ${statSync(lcovPath).mtime.toISOString()})`,
  )
}

if (import.meta.main) main()

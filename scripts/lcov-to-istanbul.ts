// Bridges Bun's lcov-only coverage output to the Istanbul JSON format that
// crap4ts requires. Bun emits per-line DA records; each line becomes one
// statement so line-range overlap in crap4ts resolves to real coverage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export interface IstanbulLocation {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

export interface IstanbulFileCoverage {
  path: string
  statementMap: Record<string, IstanbulLocation>
  s: Record<string, number>
}

export type IstanbulCoverage = Record<string, IstanbulFileCoverage>

export function parseLcov(lcov: string, repoRoot: string): IstanbulCoverage {
  const result: IstanbulCoverage = {}
  let current: IstanbulFileCoverage | undefined
  for (const record of lcov.split("\n")) {
    if (record.startsWith("SF:")) {
      const path = resolve(repoRoot, record.slice("SF:".length).trim())
      current = result[path] ?? { path, statementMap: {}, s: {} }
      result[path] = current
      continue
    }
    if (current && record.startsWith("DA:")) {
      const [lineText, hitsText] = record.slice("DA:".length).split(",")
      const line = Number(lineText)
      const hits = Number(hitsText)
      if (!Number.isInteger(line) || !Number.isFinite(hits)) continue
      const id = String(Object.keys(current.statementMap).length)
      current.statementMap[id] = { start: { line, column: 0 }, end: { line, column: 1 } }
      current.s[id] = Math.max(0, hits)
      continue
    }
    if (record.startsWith("end_of_record")) {
      current = undefined
    }
  }
  return result
}

export function lcovToIstanbul(repoRoot: string): string {
  const lcovPath = resolve(repoRoot, "coverage", "lcov.info")
  if (!existsSync(lcovPath)) {
    throw new Error(`Missing ${lcovPath}; run \`bun run test:coverage\` first`)
  }
  const coverage = parseLcov(readFileSync(lcovPath, "utf8"), repoRoot)
  mkdirSync(resolve(repoRoot, "coverage"), { recursive: true })
  const outPath = resolve(repoRoot, "coverage", "coverage-final.json")
  writeFileSync(outPath, JSON.stringify(coverage))
  return outPath
}

if (import.meta.main) {
  const outPath = lcovToIstanbul(resolve(import.meta.dir, ".."))
  console.log(`lcov-to-istanbul: wrote ${outPath}`)
}

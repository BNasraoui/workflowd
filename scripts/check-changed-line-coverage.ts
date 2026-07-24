const changedCoveragePercent = 80
const excludedSourceFiles = new Set([
  "src/store/errors.ts",
  "src/workspace/errors.ts",
  "src/qrspi/ports.ts",
])

export type ChangedLines = ReadonlyMap<string, ReadonlySet<number>>
export type LineCoverage = ReadonlyMap<string, ReadonlyMap<number, number>>

export function buildExactDiffArguments(baseSha: string, headSha: string): ReadonlyArray<string> {
  const fullSha = /^[0-9a-f]{40}$/i
  if (!fullSha.test(baseSha) || !fullSha.test(headSha)) {
    throw new Error("Base and head revisions must be full Git SHAs")
  }
  return [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--diff-filter=ACMR",
    baseSha,
    headSha,
    "--",
  ]
}

export function parseChangedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>()
  let path: string | undefined
  for (const line of diff.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("+++ ")) {
      const value = decodeGitPath(line.slice(4))
      path = value === "/dev/null" ? undefined : value.replace(/^b\//, "")
      continue
    }
    if (!line.startsWith("@@ ")) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk === null || path === undefined) throw new Error(`Malformed diff hunk: ${line}`)
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    const lines = changed.get(path) ?? new Set<number>()
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset)
    changed.set(path, lines)
  }
  return changed
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const bytes: Array<number> = []
  const encoded = value.slice(1, -1)
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index]!
    if (character !== "\\") {
      bytes.push(...new TextEncoder().encode(character))
      continue
    }
    const escape = encoded[++index]
    if (escape === undefined) throw new Error(`Malformed Git-quoted path: ${value}`)
    const octal = /^[0-7]{3}/.exec(encoded.slice(index))
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8))
      index += 2
      continue
    }
    const escapedByte = new Map([
      ["a", 7],
      ["b", 8],
      ["t", 9],
      ["n", 10],
      ["v", 11],
      ["f", 12],
      ["r", 13],
      ['"', 34],
      ["\\", 92],
    ]).get(escape)
    if (escapedByte === undefined) throw new Error(`Malformed Git-quoted path: ${value}`)
    bytes.push(escapedByte)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))
}

export function parseLcov(
  lcov: string,
  repositoryRoot = process.cwd(),
): Map<string, Map<number, number>> {
  const coverage = new Map<string, Map<number, number>>()
  let path: string | undefined
  for (const line of lcov.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("SF:")) {
      path = normalizeSourcePath(line.slice(3), repositoryRoot)
      if (path === "") throw new Error("LCOV source path is empty")
      continue
    }
    if (!line.startsWith("DA:")) continue
    if (path === undefined) throw new Error("LCOV DA record appears before SF")
    const record = /^DA:(\d+),(\d+)(?:,[^,]+)?$/.exec(line)
    if (record === null) throw new Error(`Malformed LCOV line record: ${line}`)
    const lineNumber = Number(record[1])
    const hits = Number(record[2])
    const file = coverage.get(path) ?? new Map<number, number>()
    file.set(lineNumber, (file.get(lineNumber) ?? 0) + hits)
    coverage.set(path, file)
  }
  return coverage
}

function normalizeSourcePath(path: string, repositoryRoot: string): string {
  const normalized = path.replaceAll("\\", "/")
  const root = repositoryRoot.replaceAll("\\", "/").replace(/\/$/, "")
  return normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1)
    : normalized.replace(/^\.\//, "")
}

function eligibleSource(path: string): boolean {
  return path.startsWith("src/") && path.endsWith(".ts") && !excludedSourceFiles.has(path)
}

export function hasRuntimeStatements(source: string): boolean {
  const file = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  )
  return file.statements.some((statement) => !isTypeOnlyStatement(statement))
}

function isTypeOnlyStatement(statement: ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true
  if (
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  ) {
    return true
  }
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause
    if (clause === undefined || clause.name !== undefined) return false
    if (clause.isTypeOnly) return true
    return (
      clause.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    )
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return true
    return (
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.every((element) => element.isTypeOnly)
    )
  }
  return false
}

export function evaluateChangedLineCoverage(
  changed: ChangedLines,
  coverage: LineCoverage,
  nonExecutableFiles: ReadonlySet<string> = new Set(),
) {
  const missingFiles: Array<string> = []
  const uncovered: Array<string> = []
  let covered = 0
  let total = 0
  for (const [path, changedLines] of changed) {
    const file = evaluateChangedFile(path, changedLines, coverage, nonExecutableFiles)
    covered += file.covered
    total += file.total
    uncovered.push(...file.uncovered)
    if (file.missing) missingFiles.push(path)
  }
  missingFiles.sort((left, right) => left.localeCompare(right))
  uncovered.sort((left, right) => left.localeCompare(right))
  return {
    passed:
      missingFiles.length === 0 && (total === 0 || covered * 100 >= total * changedCoveragePercent),
    covered,
    total,
    uncovered,
    missingFiles,
  }
}

function evaluateChangedFile(
  path: string,
  changedLines: ReadonlySet<number>,
  coverage: LineCoverage,
  nonExecutableFiles: ReadonlySet<string>,
) {
  const fileCoverage = coverage.get(path)
  if (!eligibleSource(path)) {
    return { covered: 0, total: 0, uncovered: [] as Array<string>, missing: false }
  }
  if (fileCoverage === undefined) {
    return {
      covered: 0,
      total: 0,
      uncovered: [] as Array<string>,
      missing: !nonExecutableFiles.has(path),
    }
  }
  const executable = [...changedLines].flatMap((line) => {
    const hits = fileCoverage.get(line)
    return hits === undefined ? [] : [{ line, hits }]
  })
  return {
    covered: executable.filter(({ hits }) => hits > 0).length,
    total: executable.length,
    uncovered: executable.filter(({ hits }) => hits === 0).map(({ line }) => `${path}:${line}`),
    missing: false,
  }
}

async function main(): Promise<void> {
  const [baseSha, headSha] = Bun.argv.slice(2)
  if (baseSha === undefined || headSha === undefined) {
    throw new Error("Usage: bun run coverage:changed <base-sha> <head-sha>")
  }
  const subprocess = Bun.spawn(["git", ...buildExactDiffArguments(baseSha, headSha)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, diff, error] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git diff failed: ${error.trim()}`)
  const lcovFile = Bun.file("coverage/lcov.info")
  if (!(await lcovFile.exists())) throw new Error("coverage/lcov.info does not exist")
  const changed = parseChangedLines(diff)
  const coverage = parseLcov(await lcovFile.text())
  const nonExecutableFiles = new Set<string>()
  for (const path of changed.keys()) {
    if (coverage.has(path)) continue
    const sourceFile = Bun.file(path)
    if ((await sourceFile.exists()) && !hasRuntimeStatements(await sourceFile.text())) {
      nonExecutableFiles.add(path)
    }
  }
  const result = evaluateChangedLineCoverage(changed, coverage, nonExecutableFiles)
  const percent = result.total === 0 ? 100 : (result.covered / result.total) * 100
  console.log(
    `Changed executable line coverage: ${result.covered}/${result.total} (${percent.toFixed(2)}%)`,
  )
  if (result.uncovered.length > 0) console.error(`Uncovered lines:\n${result.uncovered.join("\n")}`)
  if (result.missingFiles.length > 0) {
    console.error(`Changed source files missing from LCOV:\n${result.missingFiles.join("\n")}`)
  }
  if (!result.passed) process.exitCode = 1
}

if (import.meta.main) await main()
import ts from "typescript"

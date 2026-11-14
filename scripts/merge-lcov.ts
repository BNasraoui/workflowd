// Sums LCOV reports into one record per source file, so coverage that only the
// capability launcher suites reach joins the shared coverage gates. Only
// repository-relative sources and counts pass; any other line is refused, so
// child test output can never travel inside a merged report.
//
// Bun attributes a few statements to neighbouring lines from run to run. The first
// report that holds a file therefore fixes its executable lines and branches; later
// reports add hits to those only, so a shifted line never becomes a new uncovered line.

interface FileCoverage {
  readonly lines: Map<number, number>
  readonly functions: Map<string, number>
  readonly functionHits: Map<string, number>
  readonly branches: Map<string, number | null>
  functionsFound: number
  functionsHit: number
}

const count = (text: string, line: string) => {
  if (!/^\d+$/.test(text)) throw new Error(`Malformed LCOV count: ${line}`)
  return Number(text)
}

function sourcePath(path: string): string {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment === "") ||
    [...path].some((character) => character < " ")
  )
    throw new Error(`LCOV source must be repository-relative: ${JSON.stringify(path)}`)
  return path
}

function record(files: Map<string, FileCoverage>, path: string): FileCoverage {
  const existing = files.get(path)
  if (existing) return existing
  const created: FileCoverage = {
    lines: new Map(),
    functions: new Map(),
    functionHits: new Map(),
    branches: new Map(),
    functionsFound: 0,
    functionsHit: 0,
  }
  files.set(path, created)
  return created
}

function addRecord(
  file: FileCoverage,
  line: string,
  functionsSeen: { found: number; hit: number },
  defines: boolean,
) {
  const separator = line.indexOf(":")
  const key = line.slice(0, separator)
  const value = line.slice(separator + 1)
  const fields = value.split(",")
  if (key === "DA") {
    const [lineNumber = "", hits = ""] = fields
    const at = count(lineNumber, line)
    const added = count(hits, line)
    if (defines || file.lines.has(at)) file.lines.set(at, (file.lines.get(at) ?? 0) + added)
  } else if (key === "FN") {
    const name = fields.slice(1).join(",")
    file.functions.set(name, count(fields[0] ?? "", line))
  } else if (key === "FNDA") {
    const name = fields.slice(1).join(",")
    file.functionHits.set(name, (file.functionHits.get(name) ?? 0) + count(fields[0] ?? "", line))
  } else if (key === "BRDA") {
    const [lineNumber = "", block = "", branch = "", taken = ""] = fields
    const id = [lineNumber, block, branch].map((part) => count(part, line)).join(",")
    const previous = file.branches.get(id) ?? null
    const hits = taken === "-" ? null : count(taken, line)
    if (defines || file.branches.has(id))
      file.branches.set(id, hits === null ? previous : (previous ?? 0) + hits)
  } else if (key === "FNF") functionsSeen.found = count(value, line)
  else if (key === "FNH") functionsSeen.hit = count(value, line)
  else if (!["LF", "LH", "BRF", "BRH"].includes(key))
    throw new Error(`Unsupported LCOV record: ${line}`)
}

function parse(files: Map<string, FileCoverage>, report: string) {
  const known = new Set(files.keys())
  let file: FileCoverage | undefined
  let defines = false
  const functionsSeen = { found: 0, hit: 0 }
  for (const line of report.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "" || line.startsWith("TN:")) continue
    if (line.startsWith("SF:")) {
      if (file) throw new Error("LCOV record is missing end_of_record")
      const path = sourcePath(line.slice(3))
      defines = !known.has(path)
      file = record(files, path)
      functionsSeen.found = functionsSeen.hit = 0
      continue
    }
    if (!file) throw new Error(`LCOV line outside a record: ${line}`)
    if (line === "end_of_record") {
      // Bun reports function totals only. Hits from separate runs cannot be summed
      // without names, so keep the largest, which never overstates coverage.
      file.functionsFound = Math.max(file.functionsFound, functionsSeen.found)
      file.functionsHit = Math.max(file.functionsHit, functionsSeen.hit)
      file = undefined
      continue
    }
    addRecord(file, line, functionsSeen, defines)
  }
  if (file) throw new Error("LCOV record is missing end_of_record")
}

function render(path: string, file: FileCoverage): string {
  const out = ["TN:", `SF:${path}`]
  for (const [name, line] of file.functions) out.push(`FN:${line},${name}`)
  for (const [name, hits] of file.functionHits) out.push(`FNDA:${hits},${name}`)
  const named = file.functions.size > 0
  const found = named ? file.functions.size : file.functionsFound
  const hit = named
    ? [...file.functions.keys()].filter((name) => (file.functionHits.get(name) ?? 0) > 0).length
    : Math.min(file.functionsHit, found)
  out.push(`FNF:${found}`, `FNH:${hit}`)
  const lines = [...file.lines].sort(([left], [right]) => left - right)
  for (const [line, hits] of lines) out.push(`DA:${line},${hits}`)
  out.push(`LF:${lines.length}`, `LH:${lines.filter(([, hits]) => hits > 0).length}`)
  if (file.branches.size > 0) {
    for (const [id, hits] of file.branches) out.push(`BRDA:${id},${hits ?? "-"}`)
    const taken = [...file.branches.values()].filter((hits) => (hits ?? 0) > 0).length
    out.push(`BRF:${file.branches.size}`, `BRH:${taken}`)
  }
  out.push("end_of_record")
  return out.join("\n") + "\n"
}

export function mergeLcov(reports: ReadonlyArray<string>): string {
  const files = new Map<string, FileCoverage>()
  for (const report of reports) parse(files, report)
  return [...files.keys()]
    .sort()
    .map((path) => render(path, files.get(path)!))
    .join("")
}

if (import.meta.main) {
  const [output, ...inputs] = process.argv.slice(2)
  if (!output || inputs.length === 0)
    throw new Error("Usage: bun scripts/merge-lcov.ts OUTPUT INPUT...")
  const reports = await Promise.all(inputs.map((input) => Bun.file(input).text()))
  await Bun.write(output, mergeLcov(reports))
}

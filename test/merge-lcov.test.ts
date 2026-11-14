import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeLcov } from "../scripts/merge-lcov"

const bunRecord = (path: string, lines: string, functions = "FNF:2\nFNH:1") =>
  `TN:\nSF:${path}\n${functions}\n${lines}\nLF:0\nLH:0\nend_of_record\n`

test("sums line hits per file and line and recomputes the totals", () => {
  const merged = mergeLcov([
    bunRecord("src/a.ts", "DA:1,1\nDA:2,0\nDA:3,0"),
    bunRecord("src/a.ts", "DA:2,0\nDA:3,4", "FNF:2\nFNH:2") + bunRecord("src/b.ts", "DA:7,0"),
  ])
  expect(merged).toBe(
    [
      "TN:",
      "SF:src/a.ts",
      "FNF:2",
      "FNH:2",
      "DA:1,1",
      "DA:2,0",
      "DA:3,4",
      "LF:3",
      "LH:2",
      "end_of_record",
      "TN:",
      "SF:src/b.ts",
      "FNF:2",
      "FNH:1",
      "DA:7,0",
      "LF:1",
      "LH:0",
      "end_of_record",
      "",
    ].join("\n"),
  )
})

test("the first report fixes a file's lines, so a shifted line adds no uncovered line", () => {
  const merged = mergeLcov([
    bunRecord("src/a.ts", "DA:1,1\nDA:4,0"),
    bunRecord("src/a.ts", "DA:1,2\nDA:4,3\nDA:5,0") + bunRecord("src/new.ts", "DA:2,0\nDA:3,1"),
    bunRecord("src/new.ts", "DA:2,5\nDA:9,0"),
  ])
  expect(merged).toContain("SF:src/a.ts\nFNF:2\nFNH:1\nDA:1,3\nDA:4,3\nLF:2\nLH:2\n")
  expect(merged).toContain("SF:src/new.ts\nFNF:2\nFNH:1\nDA:2,5\nDA:3,1\nLF:2\nLH:2\n")
})

test("sums named function and branch hits", () => {
  const report = (fnda: number, taken: string) =>
    `SF:src/c.ts\nFN:3,run\nFN:9,idle\nFNDA:${fnda},run\nFNDA:0,idle\nFNF:2\nFNH:1\nDA:3,${fnda}\nBRDA:3,0,0,${taken}\nBRDA:3,0,1,-\nBRF:2\nBRH:0\nend_of_record\n`
  expect(mergeLcov([report(2, "-"), report(0, "5")])).toBe(
    [
      "TN:",
      "SF:src/c.ts",
      "FN:3,run",
      "FN:9,idle",
      "FNDA:2,run",
      "FNDA:0,idle",
      "FNF:2",
      "FNH:1",
      "DA:3,2",
      "LF:1",
      "LH:1",
      "BRDA:3,0,0,5",
      "BRDA:3,0,1,-",
      "BRF:2",
      "BRH:1",
      "end_of_record",
      "",
    ].join("\n"),
  )
})

test("refuses sources outside the repository and lines that are not counts", () => {
  for (const path of ["/home/runner/work/src/a.ts", "../a.ts", "src/../../a.ts", "src//a.ts"])
    expect(() => mergeLcov([bunRecord(path, "DA:1,1")])).toThrow("repository-relative")
  expect(() => mergeLcov([bunRecord("src/a.ts", "child diagnostic output")])).toThrow(
    "Unsupported LCOV record",
  )
  expect(() => mergeLcov([bunRecord("src/a.ts", "DA:1,secret")])).toThrow("Malformed LCOV count")
  expect(() => mergeLcov(["DA:1,1\n"])).toThrow("outside a record")
  expect(() => mergeLcov(["SF:src/a.ts\nDA:1,1\n"])).toThrow("missing end_of_record")
})

test("the command writes the merged report", async () => {
  const root = await mkdtemp(join(tmpdir(), "merge-lcov-"))
  try {
    await writeFile(join(root, "one.info"), bunRecord("src/a.ts", "DA:1,0"))
    await writeFile(join(root, "two.info"), bunRecord("src/a.ts", "DA:1,3"))
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/merge-lcov.ts",
        join(root, "merged.info"),
        join(root, "one.info"),
        join(root, "two.info"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    expect(await Bun.file(join(root, "merged.info")).text()).toContain("DA:1,3\nLF:1\nLH:1\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

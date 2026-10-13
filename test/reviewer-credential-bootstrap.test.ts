import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const guide = await readFile(new URL("../docs/review-hardening.md", import.meta.url), "utf8")
const script = guide.split("<<'PY'\n")[1]!.split("\nPY")[0]!
const provider = "zai-coding-plan"
const key = JSON.stringify({ type: "key", key: "synthetic-key" })

async function bootstrap(values: string[], activeIndices = [0]) {
  const root = await mkdtemp(join(tmpdir(), "reviewer-credentials-"))
  const sourcePath = join(root, "source.db")
  const targetPath = join(root, "target.db")
  const source = new Database(sourcePath)
  const target = new Database(targetPath)
  try {
    for (const db of [source, target]) {
      db.exec(`CREATE TABLE credential (
        id TEXT PRIMARY KEY, integration_id TEXT, connector_id TEXT, method_id TEXT,
        label TEXT, value TEXT, active INTEGER DEFAULT 0,
        time_created INTEGER, time_updated INTEGER
      )`)
    }
    values.forEach((value, index) => {
      source
        .query("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          `credential-${index}`,
          provider,
          "connector",
          "key",
          "review",
          value,
          activeIndices.includes(index) ? 1 : 0,
          123,
          456,
        )
    })
    const process = Bun.spawn(["python3", "-", sourcePath, targetPath, provider], {
      stdin: new Blob([script]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return {
      exitCode,
      stdout,
      stderr,
      rows: target.query("SELECT * FROM credential").all(),
      selected: source.query("SELECT * FROM credential WHERE active = 1").all(),
      mode: (await stat(targetPath)).mode & 0o777,
    }
  } finally {
    source.close()
    target.close()
    await rm(root, { recursive: true, force: true })
  }
}

test("copies the active key from four provider rows, preserving every column", async () => {
  const result = await bootstrap([key, key, key, key], [2])
  expect(result.exitCode).toBe(0)
  expect(result.rows).toEqual(result.selected)
  expect(result.mode).toBe(0o600)
  expect(result.stdout + result.stderr).toBe("")
})

test("preserves connector, method and active metadata for a single key", async () => {
  const result = await bootstrap([key])
  expect(result.exitCode).toBe(0)
  expect(result.rows).toEqual(result.selected)
})

test.each([
  JSON.stringify({ type: "oauth", refresh: "synthetic-refresh" }),
  JSON.stringify({ type: "unknown", key: "synthetic-key" }),
  "{}",
  "null",
  "not-json",
])("refuses non-key or malformed credential values (%s)", async (value) => {
  const result = await bootstrap([value])
  expect(result.exitCode).not.toBe(0)
  expect(result.rows).toEqual([])
  expect(result.stdout + result.stderr).not.toContain("synthetic-")
})

test("refuses a provider without an active credential", async () => {
  const result = await bootstrap([key], [])
  expect(result.exitCode).not.toBe(0)
  expect(result.rows).toEqual([])
})

test("refuses ambiguous active credentials", async () => {
  const result = await bootstrap([key, key], [0, 1])
  expect(result.exitCode).not.toBe(0)
  expect(result.rows).toEqual([])
})

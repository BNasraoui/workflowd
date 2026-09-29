import { expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { incrementalLines } from "../../src/kernel/codex-output"

test("drains bytes appended during the terminal check exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-final-drain-"))
  try {
    const path = join(root, "events.jsonl")
    await writeFile(path, "first\n")
    const events = incrementalLines({
      path,
      pollIntervalMs: 1,
      parse: (line) => line,
      shouldStop: async () => {
        await appendFile(path, "final\n")
        return true
      },
    })
    const output: string[] = []
    for await (const event of events) output.push(event)
    expect(output).toEqual(["first", "final"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

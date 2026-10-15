import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owner } from "./owner"

test("startup removes dead recovery directories but preserves live, unknown and pending owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-review-"))
  const dead = owner().split(".")
  dead[6] = "0"
  const make = (name: string, id: string, launcher = id) => {
    const directory = join(root, `workflowd-test-run-${name}`)
    mkdirSync(directory)
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({ owner: id, launcher, directory }),
    )
    return directory
  }
  try {
    const stale = make("dead", dead.join("."))
    const live = make("live", owner())
    const unknown = make("unknown", "unknown")
    const launching = make("launching", dead.join("."), owner())
    const pending = make("pending", dead.join("."))
    writeFileSync(join(pending, "pending-test"), owner())
    const unlabelled = join(root, "workflowd-test-run-unlabelled")
    mkdirSync(unlabelled)
    const path = join(root, "proof.test.ts")
    writeFileSync(path, `import {test} from 'bun:test'; test('sweep',()=>{});`)
    const child = Bun.spawn([process.execPath, "test", path], {
      env: { ...process.env, TMPDIR: root },
      stdout: "ignore",
      stderr: "pipe",
    })
    const output = await new Response(child.stderr).text()
    expect(await child.exited, output).toBe(0)
    expect(existsSync(stale)).toBe(false)
    for (const directory of [live, unknown, launching, pending, unlabelled])
      expect(existsSync(directory)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

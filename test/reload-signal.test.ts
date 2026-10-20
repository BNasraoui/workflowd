import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signalWorkflowdReload } from "../src/config-reload-signal"

// A separate process proves delivery uses one PID, without forwarding through a supervisor.
test("reload targets the daemon under a wrapper and leaves siblings and the wrapper alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-hup-"))
  const entry = join(root, "main.ts")
  const ready = join(root, "ready")
  const signal = join(root, "signal")
  const sibling = join(root, "sibling.ts")
  await writeFile(
    entry,
    `process.on('SIGHUP', () => { void Bun.write(${JSON.stringify(signal)}, 'received') }); await Bun.write(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)`,
  )
  await writeFile(sibling, `setInterval(() => {}, 1000)`)
  const wrapper = join(root, "wrapper.ts")
  await writeFile(
    wrapper,
    `const children = [Bun.spawn([process.execPath, ${JSON.stringify(entry)}]), Bun.spawn([process.execPath, ${JSON.stringify(sibling)}])]; process.on('SIGTERM', () => { for (const child of children) child.kill(); process.exit(0) }); setInterval(() => {}, 1000)`,
  )
  const child = Bun.spawn([process.execPath, wrapper], { stdout: "ignore", stderr: "pipe" })
  try {
    for (let i = 0; i < 100 && !(await Bun.file(ready).exists()); i++) await Bun.sleep(10)
    expect(await Bun.file(ready).exists()).toBe(true)
    await signalWorkflowdReload(child.pid, entry)
    for (let i = 0; i < 100 && !(await Bun.file(signal).exists()); i++) await Bun.sleep(10)
    expect(await readFile(signal, "utf8")).toBe("received")
    expect(child.exitCode).toBeNull()
    const missing = join(root, "missing.ts")
    await writeFile(missing, "")
    await expect(signalWorkflowdReload(child.pid, missing)).rejects.toThrow(
      "Expected one workflowd process",
    )
  } finally {
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
})

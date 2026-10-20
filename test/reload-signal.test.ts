import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signalWorkflowdReload } from "../src/config-reload-signal"
import { until } from "./helpers/reload"

async function fixture(
  phase: "ready" | "startup" | "shutdown" | "ambiguous" | "thread",
  run: (input: { pid: number; entry: string; received: string }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "workflowd-hup-"))
  const entry = join(root, "main.ts")
  const received = join(root, "received")
  const ready = join(root, "ready")
  const closed =
    phase === "shutdown"
      ? `const { startConfigReload } = await import(${JSON.stringify(join(import.meta.dir, "../src/config-reload.ts"))}); const reload = await startConfigReload({ WORKFLOWD_MODE: 'execution' }, () => {}); await reload.close();`
      : ""
  await writeFile(
    entry,
    `${closed}
    ${phase === "startup" || phase === "shutdown" ? "" : `process.on('SIGHUP', () => { void Bun.write(${JSON.stringify(received)}, 'received') });`}
    await Bun.write(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)`,
  )
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "bun main.ts" } }))
  const launcher = phase === "thread" ? join(root, "thread.ts") : join(root, "wrapper.ts")
  const secondReady = join(root, "second-ready")
  const spawn = `const a = Bun.spawn([process.execPath, "run", "start", ${JSON.stringify(ready)}], { cwd: ${JSON.stringify(root)} });
    const b = Bun.spawn([process.execPath, ${JSON.stringify(phase === "ambiguous" ? entry : join(root, "sibling.ts"))}, ${JSON.stringify(secondReady)}]);`
  await writeFile(
    join(root, "sibling.ts"),
    `await Bun.write(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)`,
  )
  await writeFile(
    launcher,
    `${spawn} process.on('SIGTERM', () => { a.kill(); b.kill(); process.exit(0) }); setInterval(() => {}, 1000)`,
  )
  if (phase === "thread") {
    await writeFile(
      join(root, "wrapper.ts"),
      `new Worker(${JSON.stringify(launcher)}); setInterval(() => {}, 1000)`,
    )
  }
  const child = Bun.spawn([process.execPath, join(root, "wrapper.ts")], {
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    await until(
      async () => (await Bun.file(ready).exists()) && (await Bun.file(secondReady).exists()),
    )
    await run({ pid: child.pid, entry, received })
    expect(child.exitCode).toBeNull()
    for (const path of [ready, secondReady]) process.kill(Number(await Bun.file(path).text()), 0)
  } finally {
    for (const path of [ready, secondReady]) {
      if (await Bun.file(path).exists()) {
        try {
          process.kill(Number(await Bun.file(path).text()), "SIGTERM")
        } catch {
          /* Already exited. */
        }
      }
    }
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}

for (const phase of ["ready", "thread"] as const) {
  test(`reload targets only the daemon under a ${phase} wrapper`, async () => {
    await fixture(phase, async ({ pid, entry, received }) => {
      await signalWorkflowdReload(pid, entry)
      await until(() => Bun.file(received).exists())
      expect(await Bun.file(received).text()).toBe("received")
      const missing = join(entry, "..", "missing.ts")
      await writeFile(missing, "")
      await expect(signalWorkflowdReload(pid, missing)).rejects.toThrow(
        "Expected one workflowd process",
      )
    })
  }, 20_000)
}

for (const phase of ["startup", "shutdown", "ambiguous"] as const) {
  test(`reload refuses a daemon during ${phase}`, async () => {
    await fixture(phase, async ({ pid, entry }) => {
      await expect(signalWorkflowdReload(pid, entry)).rejects.toThrow(
        phase === "ambiguous" ? "Expected one workflowd process" : "SIGHUP handler",
      )
    })
  }, 20_000)
}

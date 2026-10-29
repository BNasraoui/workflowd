import { expect, test } from "bun:test"
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signalWorkflowdReload } from "../src/config-reload-signal"
import { until } from "./helpers/reload"

async function fixture(
  phase: "ready" | "startup" | "shutdown" | "ambiguous" | "thread" | "private",
  run: (input: { pid: number; entry: string; received: string }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "workflowd-hup-"))
  const entry = join(root, "main.ts")
  const received = join(root, "received")
  const ready = join(root, "ready")
  // PR_SET_DUMPABLE=0 reproduces noscope's ptrace-gated proc links without privileges.
  const privateProcess =
    phase === "private"
      ? `const { dlopen, FFIType } = await import('bun:ffi'); const libc = dlopen('libc.so.6', { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } }); if (libc.symbols.prctl(4, 0, 0, 0, 0) !== 0) throw new Error('prctl failed');`
      : ""
  const closed =
    phase === "shutdown"
      ? `const { startConfigReload } = await import(${JSON.stringify(join(import.meta.dir, "../src/config-reload.ts"))}); const reload = await startConfigReload({ WORKFLOWD_MODE: 'execution' }, () => {}); await reload.close();`
      : ""
  await writeFile(
    entry,
    `${privateProcess}
    ${closed}
    ${phase === "startup" || phase === "shutdown" ? "" : `process.on('SIGHUP', () => { void Bun.write(${JSON.stringify(received)}, 'received') });`}
    await Bun.write(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)`,
  )
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "bun main.ts" } }))
  const launcher = phase === "thread" ? join(root, "thread.ts") : join(root, "wrapper.ts")
  const secondReady = join(root, "second-ready")
  const spawn = `const a = Bun.spawn([process.execPath, "run", "start", ${JSON.stringify(ready)}], { cwd: ${JSON.stringify(root)} });
    const b = Bun.spawn([process.execPath, ${JSON.stringify(phase === "ambiguous" ? entry : join(root, "sibling.ts"))}, ${JSON.stringify(secondReady)}, ${JSON.stringify(entry)}]);`
  await writeFile(
    join(root, "sibling.ts"),
    `await Bun.write(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)`,
  )
  await writeFile(
    launcher,
    `${privateProcess} ${spawn} process.on('SIGTERM', () => { a.kill(); b.kill(); process.exit(0) }); setInterval(() => {}, 1000)`,
  )
  if (phase === "thread") {
    await writeFile(
      join(root, "wrapper.ts"),
      `new Worker(${JSON.stringify(launcher)}); setInterval(() => {}, 1000)`,
    )
  }
  const child = Bun.spawn([process.execPath, join(root, "wrapper.ts"), entry], {
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
        "No workflowd process matched",
      )
    })
  }, 20_000)
}

for (const phase of ["startup", "shutdown", "ambiguous"] as const) {
  test(`reload refuses a daemon during ${phase}`, async () => {
    await fixture(phase, async ({ pid, entry }) => {
      await expect(signalWorkflowdReload(pid, entry)).rejects.toThrow(
        phase === "ambiguous" ? "Several workflowd processes matched" : "SIGHUP handler",
      )
    })
  }, 20_000)
}

test("the helper CLI reloads with unreadable proc exe and cwd", async () => {
  await fixture("private", async ({ pid, entry, received }) => {
    const daemonPid = Number(await Bun.file(join(entry, "..", "ready")).text())
    for (const target of [pid, daemonPid]) {
      for (const link of ["exe", "cwd"])
        await expect(readlink(`/proc/${target}/${link}`)).rejects.toHaveProperty("code", "EACCES")
      for (const file of ["cmdline", "stat", "status", `task/${target}/children`])
        expect((await readFile(`/proc/${target}/${file}`, "utf8")).length).toBeGreaterThanOrEqual(0)
    }
    const helper = join(entry, "..", "config-reload-signal.ts")
    await writeFile(helper, await readFile(join(import.meta.dir, "../src/config-reload-signal.ts")))
    const command = Bun.spawn([process.execPath, helper, String(pid)], { stderr: "pipe" })
    const error = await new Response(command.stderr).text()
    expect({ exit: await command.exited, error }).toEqual({ exit: 0, error: "" })
    await until(() => Bun.file(received).exists())
  })
}, 20_000)

test("the helper CLI explains refusals without exposing paths", async () => {
  const helper = join(import.meta.dir, "../src/config-reload-signal.ts")
  for (const [pid, reason] of [
    ["1", "Invalid main PID"],
    [String(process.pid), "No workflowd process matched"],
  ] as const) {
    const command = Bun.spawn([process.execPath, helper, pid, "/secret/path"], { stderr: "pipe" })
    const error = await new Response(command.stderr).text()
    expect(await command.exited).toBe(1)
    expect(error).toContain(reason)
    expect(error).not.toContain("/secret/path")
    expect(error).not.toContain(import.meta.dir)
  }
})

test("reload refuses invalid and nonexistent main PIDs", async () => {
  for (const pid of [NaN, -1, 0, 1, 1.5])
    await expect(signalWorkflowdReload(pid)).rejects.toThrow("Invalid main PID")
  // Linux PIDs cannot reach this value; no signal should be attempted.
  await expect(signalWorkflowdReload(2_147_483_647)).rejects.toThrow("No workflowd process matched")
})

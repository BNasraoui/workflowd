import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signalWorkflowdReload } from "../src/config-reload-signal"
import { until } from "./helpers/reload"

test("a real daemon handles HUP, keeps its HTTP port and logs only names", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-hup-daemon-"))
  const file = join(root, "env")
  await writeFile(file, "")
  const entry = join(import.meta.dir, "fixtures/config-reload-daemon.ts")
  const child = Bun.spawn([process.execPath, entry], {
    env: {
      PATH: process.env.PATH,
      WORKFLOWD_MODE: "execution",
      WORKFLOWD_HOST: "127.0.0.1",
      WORKFLOWD_DATABASE_PATH: join(root, "state.db"),
      WORKFLOWD_CONFIG_RELOAD_FILES: JSON.stringify([file]),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  let output = ""
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk)
  }
  const readers = Promise.all([read(child.stdout), read(child.stderr)])
  try {
    await until(async () => output.includes("workflowd listening"))
    const port = /workflowd listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)![1]
    await writeFile(file, "WORKFLOWD_PORT=9999\nIGNORED_SECRET=never-log-this-value\n")
    await signalWorkflowdReload(child.pid, entry)
    await until(async () => output.includes("Configuration reload:"))
    expect(output.split("\n").find((line) => line.startsWith("Configuration reload:"))).toBe(
      "Configuration reload: changed=none restart_required=IGNORED_SECRET,WORKFLOWD_PORT restart_required_groups=http",
    )
    expect(output).not.toContain("never-log-this-value")
    expect((await fetch(`http://127.0.0.1:${port}/hooks/github`, { method: "POST" })).status).toBe(
      404,
    )
    expect(child.exitCode).toBeNull()
  } finally {
    child.kill("SIGINT")
    await child.exited
    await readers
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

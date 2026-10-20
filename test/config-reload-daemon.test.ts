import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signalWorkflowdReload } from "../src/config-reload-signal"

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("Daemon did not reach the expected state")
}

test("a real daemon handles HUP, keeps its HTTP port and logs only names", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-hup-daemon-"))
  const file = join(root, "env")
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  await reservation.stop(true)
  await writeFile(file, "WORKFLOWD_PORT=9999\nIGNORED_SECRET=never-log-this-value\n")
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    env: {
      PATH: process.env.PATH,
      WORKFLOWD_MODE: "execution",
      WORKFLOWD_HOST: "127.0.0.1",
      WORKFLOWD_PORT: String(port),
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
    await signalWorkflowdReload(child.pid)
    await until(async () => output.includes("Configuration reload:"))
    expect(output).toContain("restart_required=")
    expect(output).toContain("WORKFLOWD_PORT")
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
})

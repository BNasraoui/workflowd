import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveRunSocket } from "../../src/worker-identity/peer"
import { requestRunSocket } from "../../src/worker-identity/socket-client"
import { runWorkerCommand, spawnWorkerCommand } from "../../src/worker-identity/command"
test("worker command acquires an App token for each invocation without argv secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-worker-command-"))
  const path = join(directory, "broker.sock")
  const server = await serveRunSocket(path, async () =>
    Response.json({ token: "app-token", expiresAt: Date.now() + 3600000 }),
  )
  const env = { WORKFLOWD_WORKER_GITHUB_SOCKET: path, WORKFLOWD_RUN_ID: "run" }
  const calls: string[][] = []
  const io = {
    request: requestRunSocket,
    run: async (argv: string[], env: Record<string, string | undefined>) => {
      calls.push(argv)
      expect(env.GH_TOKEN).toBe("app-token")
      expect(argv.join()).not.toContain("app-token")
      return 7
    },
  }
  try {
    expect(await runWorkerCommand(["--", "pr", "view"], { ...env, GH_TOKEN: "personal" }, io)).toBe(
      7,
    )
    expect(await runWorkerCommand(["--git", "--", "fetch"], env, io)).toBe(7)
    expect(calls[0]).toEqual(["gh", "pr", "view"])
    expect(calls[1]?.[0]).toBe("git")
    await expect(runWorkerCommand([], {}, io)).rejects.toThrow("environment")
    await expect(runWorkerCommand([], env, io)).rejects.toThrow("before")
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("worker command runner preserves the owned child exit status", async () => {
  expect(await spawnWorkerCommand([process.execPath, "-e", "process.exit(3)"], {})).toBe(3)
})

import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWaitCommand } from "../../src/cli"
import { registerResidentWait } from "../../src/resident/wait"
import { runWorkerCommand, spawnWorkerCommand } from "../../src/worker-identity/command"
test("CLI wait commands enforce arguments, credentials, and bounded registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-wait-cli-"))
  const secret = join(directory, "token")
  await writeFile(secret, "test-token")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      request.method === "POST"
        ? Response.json({ status: "waiting" }, { status: 202 })
        : Response.json({
            repository: "o/r",
            sha: "a".repeat(40),
            sequence: 1,
            conclusion: "success",
            failingJobs: [],
          }),
  })
  try {
    const io = { fetch, log: () => {}, heartbeat: () => {} }
    const args = ["wait", "ci", "--repo", "o/r", "--sha", "a".repeat(40)]
    expect(
      await runWaitCommand(
        args,
        { WORKFLOWD_URL: server.url.toString(), WORKFLOWD_CI_TOKEN_FILE: secret },
        io,
      ),
    ).toBe(0)
    await expect(runWaitCommand([], {}, io)).rejects.toThrow("Usage")
    await expect(runWaitCommand(args, {}, io)).rejects.toThrow("TOKEN")
    await registerResidentWait(["--thread", "thread", "--repo", "o/r", "--sha", "a".repeat(40)], {
      WORKFLOWD_URL: server.url.toString(),
      WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE: secret,
    })
    await expect(registerResidentWait([], {})).rejects.toThrow("requires")
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})
test("worker command acquires an App token for each invocation without argv secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-worker-command-"))
  const path = join(directory, "identity.json")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ token: "app-token", expiresAt: Date.now() + 3600000 }),
  })
  await writeFile(
    path,
    JSON.stringify({ endpoint: server.url.toString(), runId: "run", capability: "cap" }),
  )
  const calls: string[][] = []
  const io = {
    request: fetch,
    run: async (argv: string[], env: Record<string, string | undefined>) => {
      calls.push(argv)
      expect(env.GH_TOKEN).toBe("app-token")
      expect(argv.join()).not.toContain("app-token")
      return 7
    },
  }
  try {
    expect(
      await runWorkerCommand(
        ["--identity", path, "--", "pr", "view"],
        { GH_TOKEN: "personal" },
        io,
      ),
    ).toBe(7)
    expect(await runWorkerCommand(["--identity", path, "--git", "--", "fetch"], {}, io)).toBe(7)
    expect(calls[0]).toEqual(["gh", "pr", "view"])
    expect(calls[1]?.[0]).toBe("git")
    await expect(runWorkerCommand([], {}, io)).rejects.toThrow("identity")
    await expect(runWorkerCommand(["--identity", path], {}, io)).rejects.toThrow("before")
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("worker command runner preserves the owned child exit status", async () => {
  expect(await spawnWorkerCommand([process.execPath, "-e", "process.exit(3)"], {})).toBe(3)
})

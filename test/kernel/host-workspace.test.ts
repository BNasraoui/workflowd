import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { runHostWorker } from "../../src/kernel/codex-worker"

test("host workspace reuse preserves checkout and reinstalls its guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-workspace-"))
  const directory = join(root, "checkout")
  const git = {
    name: "Fixture",
    email: "agent@example.test",
    blockedEmails: ["blocked@example.test"],
  }
  try {
    await mkdir(directory)
    const command = Bun.spawn(["git", "init", "-b", "original", directory], {
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(await command.exited).toBe(0)
    await writeFile(join(directory, "dirty"), "keep work")
    for (const branch of ["requested", "different"]) {
      const io = join(root, branch)
      await mkdir(io)
      await writeFile(
        join(io, "input"),
        JSON.stringify({
          operation: "start",
          runId: branch,
          profile: "workspace",
          directory,
          repository: "/nonexistent/repo",
          branch,
          base: "nonexistent-base",
          prompt: "",
          model: null,
          git,
        }),
      )
      expect(await runHostWorker(join(io, "input"), "/unused", io)).toBe(0)
      expect(await readFile(join(directory, "dirty"), "utf8")).toBe("keep work")
      expect(await readFile(join(directory, ".git", "HEAD"), "utf8")).toBe(
        "ref: refs/heads/original\n",
      )
      const config = Bun.spawn(["git", "-C", directory, "config", "core.hooksPath"], {
        stdout: "pipe",
      })
      const hooks = (await new Response(config.stdout).text()).trim()
      expect(await config.exited).toBe(0)
      expect(await readFile(resolve(directory, hooks, "pre-commit"), "utf8")).toContain(
        "identity-guard",
      )
      await rm(resolve(directory, hooks, "pre-commit"))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

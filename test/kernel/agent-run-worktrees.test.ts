import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { gitAgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"

const initRepository = async (directory: string) => {
  const run = async (...command: Array<string>) => {
    const child = Bun.spawn(command, { cwd: directory, stdout: "pipe", stderr: "pipe" })
    const status = await child.exited
    if (status !== 0) throw new Error(`${command.join(" ")} exited ${status}`)
  }
  await run("git", "init", "-q", "--initial-branch=main")
  await run("git", "config", "user.email", "test@example.invalid")
  await run("git", "config", "user.name", "Test")
  await run("git", "commit", "-q", "--allow-empty", "-m", "seed")
}

describe("gitAgentRunWorktrees", () => {
  test("creates the worktree on the requested branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-run-worktrees-"))
    try {
      const repository = join(root, "repo")
      await mkdir(repository)
      await initRepository(repository)
      const directory = join(repository, "wt-run")
      await Effect.runPromise(
        gitAgentRunWorktrees.create({ repository, directory, branch: "agent/run-1" }),
      )
      expect((await stat(join(directory, ".git"))).isFile()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("short-circuits when the directory already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-run-worktrees-"))
    try {
      const directory = join(root, "existing")
      await mkdir(directory)
      // A pre-existing directory short-circuits before git runs, so a
      // missing repository must not fail: the call succeeds and leaves the
      // directory an empty non-worktree.
      const outcome = await Effect.runPromise(
        gitAgentRunWorktrees
          .create({
            repository: join(root, "missing-repo"),
            directory,
            branch: "agent/run-2",
          })
          .pipe(Effect.result),
      )
      expect(outcome._tag).toBe("Success")
      expect(
        await stat(join(directory, ".git")).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails with a workspace error when git cannot create the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-run-worktrees-"))
    try {
      const outcome = await Effect.runPromise(
        gitAgentRunWorktrees
          .create({
            repository: join(root, "missing-repo"),
            directory: join(root, "wt-run"),
            branch: "agent/run-3",
          })
          .pipe(Effect.result),
      )
      expect(outcome._tag).toBe("Failure")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

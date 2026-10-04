import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { gitAgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import { defaultState, makeLayer, makeProvider, register } from "./agent-run-ingress-harness"

const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}

const fixture = async (root: string) => {
  const origin = join(root, "origin.git")
  const repository = join(root, "clone")
  await git(root, "init", "--bare", "--initial-branch=main", origin)
  await git(root, "clone", origin, repository)
  await git(repository, "config", "user.email", "test@example.invalid")
  await git(repository, "config", "user.name", "Test")
  await git(repository, "commit", "--allow-empty", "-m", "old")
  await git(repository, "push", "-u", "origin", "main")
  await git(repository, "checkout", "-b", "stale")
  const oldHead = await git(repository, "rev-parse", "HEAD")
  await git(repository, "push", "origin", "stale:release")
  const publisher = join(root, "publisher")
  await git(root, "clone", origin, publisher)
  await git(publisher, "config", "user.email", "test@example.invalid")
  await git(publisher, "config", "user.name", "Test")
  await git(publisher, "commit", "--allow-empty", "-m", "new")
  const newHead = await git(publisher, "rev-parse", "HEAD")
  await git(publisher, "push", "origin", "main")
  return { origin, repository, oldHead, newHead }
}

describe("agent-run fresh worktree", () => {
  test("real ingress uses the fetched origin default without changing the clone branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-run-ingress-git-"))
    try {
      const { repository, oldHead, newHead } = await fixture(root)
      expect(await git(repository, "rev-parse", "origin/main")).toBe(oldHead)
      const provider = defaultState()
      const layer = makeLayer(makeProvider(provider), gitAgentRunWorktrees, undefined, {
        repositories: [{ name: "fixture", directory: repository }],
        worktreeRoot: join(root, "worktrees"),
      })
      await Effect.runPromise(
        register({ route: "implement", repository: "fixture", prompt: "test" }).pipe(
          Effect.provide(layer),
        ),
      )
      expect(await git(provider.created[0]!.directory, "rev-parse", "HEAD")).toBe(newHead)
      expect(await git(repository, "rev-parse", "origin/main")).toBe(newHead)
      expect(await git(repository, "rev-parse", "HEAD")).toBe(oldHead)
      expect(await git(repository, "branch", "--show-current")).toBe("stale")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fetch failure refuses dispatch before creating a worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-run-ingress-git-"))
    try {
      const { repository, oldHead } = await fixture(root)
      await git(repository, "remote", "set-url", "origin", join(root, "missing-origin"))
      const provider = defaultState()
      const layer = makeLayer(makeProvider(provider), gitAgentRunWorktrees, undefined, {
        repositories: [{ name: "fixture", directory: repository }],
        worktreeRoot: join(root, "worktrees"),
      })
      const result = await Effect.runPromise(
        register({ route: "implement", repository: "fixture", prompt: "test" }).pipe(
          Effect.provide(layer),
          Effect.result,
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(provider.created).toHaveLength(0)
      expect(await git(repository, "worktree", "list", "--porcelain")).not.toContain("agent-runs")
      expect(await git(repository, "rev-parse", "HEAD")).toBe(oldHead)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an explicit base uses that fetched origin branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-run-ingress-git-"))
    try {
      const { repository, oldHead } = await fixture(root)
      const provider = defaultState()
      const layer = makeLayer(makeProvider(provider), gitAgentRunWorktrees, undefined, {
        repositories: [{ name: "fixture", directory: repository }],
        worktreeRoot: join(root, "worktrees"),
      })
      await Effect.runPromise(
        register({
          route: "implement",
          repository: "fixture",
          prompt: "test",
          baseRef: "release",
        }).pipe(Effect.provide(layer)),
      )
      expect(await git(provider.created[0]!.directory, "rev-parse", "HEAD")).toBe(oldHead)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

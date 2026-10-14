import { mkdir } from "node:fs/promises"
import { join } from "node:path"

export async function linkedWorktree(root: string) {
  const repository = join(root, "repository")
  const directory = join(root, "worktree")
  await mkdir(repository)
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    ["worktree", "add", "--detach", directory],
  ]) {
    const child = Bun.spawn(["git", ...args], {
      cwd: repository,
      stdout: "ignore",
      stderr: "ignore",
    })
    if ((await child.exited) !== 0) throw new Error("Cannot prepare fixture worktree")
  }
  return { repository, directory }
}

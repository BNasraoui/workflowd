import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { GitQrspiWorkspace } from "../../src/qrspi/workspace"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function git(cwd: string, ...args: ReadonlyArray<string>): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}

test("provisions isolated workflow worktrees at their durable head SHAs", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-qrspi-workspace-"))
  directories.push(root)
  const remote = join(root, "remote.git")
  const source = join(root, "source")
  const worktreeRoot = join(root, "worktrees")
  await mkdir(remote)
  await mkdir(source)
  await git(remote, "init", "--bare")
  await git(source, "init", "-b", "main")
  await git(source, "config", "user.email", "test@example.com")
  await git(source, "config", "user.name", "Workflowd Test")
  await writeFile(join(source, "ticket.txt"), "base\n")
  await git(source, "add", "ticket.txt")
  await git(source, "commit", "-m", "base")
  await git(source, "remote", "add", "origin", remote)
  await git(source, "push", "origin", "main")
  const firstSha = await git(source, "rev-parse", "HEAD")
  await git(source, "switch", "-c", "ticket-two")
  await writeFile(join(source, "ticket.txt"), "second\n")
  await git(source, "commit", "-am", "second")
  await git(source, "push", "origin", "ticket-two")
  const secondSha = await git(source, "rev-parse", "HEAD")

  const workspace = new GitQrspiWorkspace(source, worktreeRoot)
  const repository = {
    providerInstanceId: "github",
    repositoryId: "42",
    repositoryFullName: "owner/repo",
  }
  const first = await Effect.runPromise(
    workspace.withWorkspace(
      {
        repository,
        workflowId: "workflow-one",
        headRef: "main",
        targetSha: firstSha,
      },
      (directory) =>
        Effect.tryPromise(async () => ({
          directory,
          head: await git(directory, "rev-parse", "HEAD"),
        })),
    ),
  )
  const second = await Effect.runPromise(
    workspace.withWorkspace(
      {
        repository,
        workflowId: "workflow-two",
        headRef: "ticket-two",
        targetSha: secondSha,
      },
      (directory) =>
        Effect.tryPromise(async () => ({
          directory,
          head: await git(directory, "rev-parse", "HEAD"),
        })),
    ),
  )

  expect(first.directory).not.toBe(second.directory)
  expect(first.head).toBe(firstSha)
  expect(second.head).toBe(secondSha)
  expect(await git(first.directory, "rev-parse", "HEAD")).toBe(firstSha)
})

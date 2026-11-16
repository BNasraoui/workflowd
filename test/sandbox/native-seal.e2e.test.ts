import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { sealRun } from "../../deploy/sandbox/native-seal.mjs"
import { directoryArchive } from "../helpers/workspace-archive.mjs"

/**
 * The harness's seal (native-seal.mjs with result.py) on whole trees: the seal judges what the run
 * changed against the run's source commit, so a tracked entry that the run left as it is never
 * costs the run its result.
 */

const identity = { name: "Fixture Agent", email: "agent@example.invalid" }
const environment = {
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
}

/** Runs `argv` in `cwd` and gives its standard output; fails with its standard error. */
const run = (argv: ReadonlyArray<string>, cwd: string, input?: string) => {
  const child = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env: environment,
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (child.status !== 0)
    throw new Error(`${argv.join(" ")} exited ${child.status}: ${child.stderr.toString()}`)
  return child.stdout.toString().trim()
}

/**
 * A run of the box on `sourceSha` of the repository `repository`: `source.git` holds the source
 * commit, `workspace` its checkout with each tracked entry as Git checks it out, with the box's own
 * `.git`. `change` then changes the workspace as the agent would.
 */
async function boxRun(
  repository: string,
  sourceSha: string,
  change: (workspace: string) => Promise<void> = async () => undefined,
) {
  const directory = await mkdtemp(join(tmpdir(), "native-seal-tree-"))
  const native = join(directory, "native")
  const workspace = join(directory, "workspace")
  await mkdir(native)
  run(["git", "init", "--quiet", "--bare", "source.git"], native)
  run(["git", "-C", "source.git", "fetch", "--quiet", "--no-tags", repository, sourceSha], native)
  run(
    ["git", "clone", "--quiet", "--no-checkout", join(native, "source.git"), workspace],
    directory,
  )
  run(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", sourceSha], workspace)
  await change(workspace)
  return { directory, native, workspace }
}

/** Seals the box's workspace as the harness does; gives the result's manifest and bundle. */
async function seal(box: Awaited<ReturnType<typeof boxRun>>, sourceSha: string) {
  await sealRun({
    directory: box.directory,
    native: box.native,
    sourceSha,
    identity,
    reply: "Done.",
    workspace: () => directoryArchive(box.workspace),
  })
  const manifest: unknown = JSON.parse(
    await readFile(join(box.directory, "result", "result.json"), "utf8"),
  )
  const bundle = await readFile(join(box.directory, "result", "result.bundle")).catch(() => null)
  return { manifest, bundle }
}

/** The paths that the sealed bundle changes against `sourceSha`, and the commit's file modes. */
function changedPaths(box: Awaited<ReturnType<typeof boxRun>>, sourceSha: string) {
  const check = join(box.directory, "check.git")
  run(["git", "clone", "--quiet", "--bare", join(box.native, "source.git"), check], box.directory)
  run(
    [
      "git",
      "fetch",
      "--quiet",
      join(box.directory, "result", "result.bundle"),
      "refs/workflowd/result:refs/heads/result",
    ],
    check,
  )
  return run(["git", "diff", "--name-status", "--no-renames", sourceSha, "result"], check)
}

const credentialShaped = `token = "ghp_${"A".repeat(36)}"\n`

/**
 * A source tree that holds what the seal refuses in a change: a symlink, a file over the bound of
 * one blob, a file with credential-shaped text, a protected path and an executable file.
 */
async function guardedSource() {
  const root = await mkdtemp(join(tmpdir(), "native-seal-source-"))
  const work = join(root, "work")
  await mkdir(join(work, "deploy", "sandbox"), { recursive: true })
  await writeFile(join(work, "README.md"), "fixture\n")
  await writeFile(join(work, "large.bin"), Buffer.alloc(2 * 1024 * 1024, 7))
  await writeFile(join(work, "fixture.txt"), credentialShaped)
  await writeFile(join(work, ".gitattributes"), "*.bin binary\n")
  await writeFile(join(work, "deploy", "sandbox", "tool.sh"), "#!/bin/sh\n")
  await chmod(join(work, "deploy", "sandbox", "tool.sh"), 0o755)
  await symlink("README.md", join(work, "link.md"))
  run(["git", "init", "--quiet", "-b", "main"], work)
  run(["git", "add", "-A"], work)
  run(["git", "commit", "--quiet", "-m", "source"], work)
  return { root, work, sourceSha: run(["git", "rev-parse", "HEAD"], work) }
}

test("the seal completes a run that changed nothing in an untouched checkout of this repository", async () => {
  const repository = resolve(".")
  const sourceSha = run(["git", "rev-parse", "HEAD"], repository)
  const box = await boxRun(repository, sourceSha)
  try {
    const sealed = await seal(box, sourceSha)
    expect(sealed.bundle).toBeNull()
    expect(sealed.manifest).toEqual({
      sourceSha,
      title: "workflowd agent run",
      body: "The workspace of one agent run, sealed on its runner.",
      finalMessage: "Done.",
    })
  } finally {
    await rm(box.directory, { recursive: true, force: true })
  }
}, 120_000)

test("the seal completes a run that changed nothing in a tree with a tracked symlink, a tracked file over the bound of a blob, credential-shaped text, a protected path and an executable file", async () => {
  const source = await guardedSource()
  const box = await boxRun(source.work, source.sourceSha)
  try {
    const sealed = await seal(box, source.sourceSha)
    expect(sealed.bundle).toBeNull()
    expect(sealed.manifest).toMatchObject({ sourceSha: source.sourceSha, finalMessage: "Done." })
  } finally {
    await rm(box.directory, { recursive: true, force: true })
    await rm(source.root, { recursive: true, force: true })
  }
}, 120_000)

test("the seal of a one-line change in that tree holds that change alone", async () => {
  const source = await guardedSource()
  const box = await boxRun(source.work, source.sourceSha, (workspace) =>
    writeFile(join(workspace, "README.md"), "fixture\nchanged\n"),
  )
  try {
    const sealed = await seal(box, source.sourceSha)
    expect(sealed.bundle).not.toBeNull()
    expect(changedPaths(box, source.sourceSha)).toBe("M\tREADME.md")
  } finally {
    await rm(box.directory, { recursive: true, force: true })
    await rm(source.root, { recursive: true, force: true })
  }
}, 120_000)

import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { claudeCommand } from "../../deploy/sandbox/native-runner.mjs"
import { sealRun } from "../../deploy/sandbox/native-seal.mjs"
import { resultBounds, resultRules } from "../../deploy/sandbox/result-rules.mjs"
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

/** A source tree whose .gitignore ignores dependencies, build output and logs. */
async function ignoringSource() {
  const root = await mkdtemp(join(tmpdir(), "native-seal-ignoring-"))
  const work = join(root, "work")
  await mkdir(work)
  await writeFile(join(work, "README.md"), "fixture\n")
  await writeFile(join(work, ".gitignore"), "node_modules/\n/build/\n*.log\n")
  run(["git", "init", "--quiet", "-b", "main"], work)
  run(["git", "add", "-A"], work)
  run(["git", "commit", "--quiet", "-m", "source"], work)
  return { root, work, sourceSha: run(["git", "rev-parse", "HEAD"], work) }
}

test("the seal leaves out ignored output of any size and count, and holds the change alone", async () => {
  const source = await ignoringSource()
  const box = await boxRun(source.work, source.sourceSha, async (workspace) => {
    await writeFile(join(workspace, "README.md"), "fixture\nchanged\n")
    // Dependencies of more entries than the bound of an export, a build output over the bound of
    // a whole archive, and a log over the bound of one file.
    await mkdir(join(workspace, "node_modules", "package"), { recursive: true })
    for (let index = 0; index <= 10_000; index++)
      await writeFile(join(workspace, "node_modules", "package", `f${index}.js`), "")
    await mkdir(join(workspace, "build"))
    await writeFile(join(workspace, "build", "output.bin"), "")
    await truncate(join(workspace, "build", "output.bin"), 100 * 1024 * 1024)
    await writeFile(join(workspace, "build.log"), Buffer.alloc(1_100_000, 46))
  })
  try {
    const sealed = await seal(box, source.sourceSha)
    expect(sealed.bundle).not.toBeNull()
    expect(changedPaths(box, source.sourceSha)).toBe("M\tREADME.md")
  } finally {
    await rm(box.directory, { recursive: true, force: true })
    await rm(source.root, { recursive: true, force: true })
  }
}, 300_000)

const refusedEntries = [
  [
    "a new symbolic link",
    (workspace: string) => symlink("README.md", join(workspace, "docs-link.md")),
    'Symbolic link in the change: "docs-link.md"',
  ],
  [
    "a changed tracked symbolic link",
    async (workspace: string) => {
      await rm(join(workspace, "link.md"))
      await symlink("fixture.txt", join(workspace, "link.md"))
    },
    'Symbolic link in the change: "link.md"',
  ],
  [
    "a FIFO",
    async (workspace: string) => {
      run(["mkfifo", join(workspace, "pipe")], workspace)
    },
    'Special file in the change: "pipe"',
  ],
  [
    "a hard link",
    (workspace: string) => link(join(workspace, "README.md"), join(workspace, "hard.md")),
    /Special file in the change: "(README|hard)\.md"/,
  ],
] as const

for (const [name, change, refusal] of refusedEntries)
  test(`the seal refuses ${name} by its path`, async () => {
    const source = await guardedSource()
    const box = await boxRun(source.work, source.sourceSha, change)
    try {
      await expect(seal(box, source.sourceSha)).rejects.toThrow(refusal)
      expect(await readFile(join(box.directory, "result", "result.json")).catch(() => null)).toBe(
        null,
      )
    } finally {
      await rm(box.directory, { recursive: true, force: true })
      await rm(source.root, { recursive: true, force: true })
    }
  }, 120_000)

test("Claude Code in the box gets the rules of the result, whose bounds are the seal's", () => {
  const command = claudeCommand("claude-sonnet-4-5")
  expect(command.slice(command.indexOf("--append-system-prompt"))).toEqual([
    "--append-system-prompt",
    resultRules,
  ])
  for (const text of ["1 MiB", "8 MiB", "100 changed paths", "symbolic link", "Ignored files"])
    expect(resultRules).toContain(text)
  const seal = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('result', sys.argv[1])\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(json.dumps(m.RESULT_BOUNDS))",
      resolve("deploy/sandbox/result.py"),
    ],
    { encoding: "utf8" },
  )
  expect(JSON.parse(seal.stdout)).toEqual(resultBounds)
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repositoryRoot = join(import.meta.dir, "..")
const linker = join(repositoryRoot, "deploy", "link-agent-skills.sh")
const updater = join(repositoryRoot, "deploy", "update-dev-infra.example")

let root = ""
let home = ""
let environment: Record<string, string> = {}

interface Result {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

async function run(command: ReadonlyArray<string>, cwd = root): Promise<Result> {
  const child = Bun.spawn([...command], { cwd, env: environment, stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { status, stdout, stderr }
}

async function git(cwd: string, ...args: ReadonlyArray<string>): Promise<string> {
  const result = await run(["git", ...args], cwd)
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

async function writeSkill(checkout: string, name: string): Promise<void> {
  await mkdir(join(checkout, "skills", name), { recursive: true })
  await writeFile(join(checkout, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`)
}

async function linkTarget(path: string): Promise<string> {
  expect((await lstat(path)).isSymbolicLink()).toBe(true)
  return readlink(path)
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "workflowd-agent-skills-")))
  home = join(root, "home")
  const bin = join(root, "bin")
  await Promise.all([mkdir(home), mkdir(bin)])
  environment = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
  }
  // The updater installs dependencies and probes systemd units; record both instead.
  // systemctl fails so no unit counts as installed.
  for (const [tool, status] of [
    ["bun", 0],
    ["systemctl", 1],
  ] as const) {
    const stub = join(bin, tool)
    await writeFile(stub, `#!/bin/sh\necho "${tool} $*" >> "${root}/calls.log"\nexit ${status}\n`)
    await chmod(stub, 0o755)
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("links every rpi skill for Codex, OpenCode, and Claude Code and is idempotent", async () => {
  const checkout = join(root, "checkout")
  await writeSkill(checkout, "rpi-questions")
  await writeSkill(checkout, "rpi-plan")
  await writeSkill(checkout, "ticket-writing")
  await mkdir(join(checkout, "skills", "rpi-notes"))

  const first = await run([linker, checkout])
  expect(first.stderr).toBe("")
  expect(first.status).toBe(0)

  for (const target of [".agents/skills", ".claude/skills"]) {
    for (const skill of ["rpi-questions", "rpi-plan"]) {
      expect(await linkTarget(join(home, target, skill))).toBe(join(checkout, "skills", skill))
    }
    expect(await Bun.file(join(home, target, "ticket-writing", "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(join(home, target, "rpi-notes")).exists()).toBe(false)
  }

  const second = await run([linker, checkout])
  expect(second.status).toBe(0)
  expect(second.stdout).toBe("")
})

test("never replaces a non-symlink and still links the remaining skills", async () => {
  const checkout = join(root, "checkout")
  await writeSkill(checkout, "rpi-questions")
  await writeSkill(checkout, "rpi-plan")
  const ownCopy = join(home, ".claude", "skills", "rpi-plan")
  await mkdir(ownCopy, { recursive: true })
  await writeFile(join(ownCopy, "SKILL.md"), "local edit\n")

  const result = await run([linker, checkout])

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(`WARN: ${ownCopy} exists and is not a symlink`)
  expect(await readFile(join(ownCopy, "SKILL.md"), "utf8")).toBe("local edit\n")
  expect(await linkTarget(join(home, ".claude", "skills", "rpi-questions"))).toBe(
    join(checkout, "skills", "rpi-questions"),
  )
  expect(await linkTarget(join(home, ".agents", "skills", "rpi-plan"))).toBe(
    join(checkout, "skills", "rpi-plan"),
  )
})

test("repoints moved links and removes links to deleted skills", async () => {
  const checkout = join(root, "checkout")
  await writeSkill(checkout, "rpi-review")
  await writeSkill(checkout, "rpi-gone")
  expect((await run([linker, checkout])).status).toBe(0)
  await rm(join(checkout, "skills", "rpi-gone"), { recursive: true })
  const elsewhere = join(root, "elsewhere")
  await mkdir(elsewhere)
  const agents = join(home, ".agents", "skills")
  await rm(join(agents, "rpi-review"))
  expect((await run(["ln", "-s", elsewhere, join(agents, "rpi-review")])).status).toBe(0)

  const result = await run([linker, checkout])

  expect(result.status).toBe(0)
  expect(await linkTarget(join(agents, "rpi-review"))).toBe(join(checkout, "skills", "rpi-review"))
  for (const target of [agents, join(home, ".claude", "skills")]) {
    await expect(lstat(join(target, "rpi-gone"))).rejects.toThrow()
  }
})

test("update-dev-infra links the deployed skills on update and when already current", async () => {
  const origin = join(root, "origin")
  const deploy = join(root, "deploy")
  await mkdir(origin)
  await git(origin, "init", "-q", "-b", "main")
  await mkdir(join(origin, "deploy"))
  await writeFile(join(origin, "deploy", "link-agent-skills.sh"), await readFile(linker))
  await chmod(join(origin, "deploy", "link-agent-skills.sh"), 0o755)
  await writeFile(join(origin, "README.md"), "fixture\n")
  await git(origin, "add", ".")
  await git(origin, "commit", "-q", "-m", "initial")
  await git(root, "clone", "-q", origin, deploy)

  await writeSkill(origin, "rpi-research")
  await git(origin, "add", ".")
  await git(origin, "commit", "-q", "-m", "add skill")
  environment = { ...environment, DEPLOY: deploy }

  const updated = await run(["bash", updater])
  expect(updated.stderr).toBe("")
  expect(updated.status).toBe(0)
  const deployed = join(deploy, "skills", "rpi-research")
  expect(await linkTarget(join(home, ".agents", "skills", "rpi-research"))).toBe(deployed)
  expect(await linkTarget(join(home, ".claude", "skills", "rpi-research"))).toBe(deployed)
  expect(await readFile(join(root, "calls.log"), "utf8")).toContain("bun install --frozen-lockfile")

  await rm(join(home, ".claude", "skills", "rpi-research"))
  const current = await run(["bash", updater])
  expect(current.status).toBe(0)
  expect(current.stdout).toContain("already at origin/main")
  expect(await linkTarget(join(home, ".claude", "skills", "rpi-research"))).toBe(deployed)
})

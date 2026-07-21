import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repositoryRoot = join(import.meta.dir, "..")
const validator = join(repositoryRoot, "scripts", "validate-push-branches.sh")
const installer = join(repositoryRoot, "scripts", "install-git-hooks.sh")
const localSha = "1".repeat(40)
const remoteSha = "2".repeat(40)
const deletedSha = "0".repeat(40)

let fixtureRoot = ""
let fixtureRepository = ""
let environment: Record<string, string> = {}

async function run(
  command: ReadonlyArray<string>,
  cwd: string,
  stdin = "",
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  child.stdin.write(stdin)
  await child.stdin.end()
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { status, stdout, stderr }
}

function pushLine(localRef: string, sha = localSha): string {
  return `${localRef} ${sha} refs/heads/destination ${remoteSha}\n`
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "workflowd-pre-push-"))
  fixtureRepository = join(fixtureRoot, "repository")
  const home = join(fixtureRoot, "home")
  const bin = join(fixtureRoot, "bin")
  await Promise.all([mkdir(fixtureRepository), mkdir(home), mkdir(bin)])

  environment = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
  }

  const gitInit = await run(["git", "init", "-q"], fixtureRepository)
  expect(gitInit.status).toBe(0)

  const bd = join(bin, "bd")
  await writeFile(
    bd,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --readonly|-q) shift ;;
    -C) shift 2 ;;
    *) break ;;
  esac
done
if [ "$1" != "count" ]; then
  exit 2
fi
shift
ticket_id=
ticket_type=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id) ticket_id=$2; shift 2 ;;
    --type) ticket_type=$2; shift 2 ;;
    *) exit 2 ;;
  esac
done
count=0
while read -r known_id known_type; do
  if [ "$ticket_id" = "$known_id" ] && { [ -z "$ticket_type" ] || [ "$ticket_type" = "$known_type" ]; }; then
    count=1
  fi
done <<'TICKETS'
workflowd-feat feature
workflowd-bug bug
workflowd-task task
workflowd-chore chore
workflowd-epic epic
workflowd-parent.1 task
TICKETS
printf '%s\n' "$count"
`,
  )
  await chmod(bd, 0o755)
})

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe("pre-push branch validator", () => {
  test("accepts every supported ticket type and hierarchical ticket IDs", async () => {
    const input = [
      pushLine("refs/heads/feature/workflowd-feat-add-guard"),
      pushLine("refs/heads/bug/workflowd-bug-fix-race"),
      pushLine("refs/heads/task/workflowd-task-write-tests"),
      pushLine("refs/heads/chore/workflowd-chore-update-tooling"),
      pushLine("refs/heads/epic/workflowd-epic-release-work"),
      pushLine("refs/heads/task/workflowd-parent.1-child-work"),
    ].join("")

    const result = await run(["/bin/sh", validator], fixtureRepository, input)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
  })

  test("rejects malformed branch names with an actionable example", async () => {
    const result = await run(
      ["/bin/sh", validator],
      fixtureRepository,
      pushLine("refs/heads/feature/add-guard"),
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("feature/add-guard")
    expect(result.stderr).toContain("feature/workflowd-feat-add-guard")
    expect(result.stderr).toContain("git push --no-verify")
  })

  test("rejects missing tickets and ticket type mismatches", async () => {
    const result = await run(
      ["/bin/sh", validator],
      fixtureRepository,
      pushLine("refs/heads/bug/workflowd-missing-fix-race") +
        pushLine("refs/heads/bug/workflowd-task-fix-race"),
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("ticket 'workflowd-missing' does not exist")
    expect(result.stderr).toContain("ticket 'workflowd-task' is not a 'bug'")
    expect(result.stderr).toContain("bd show workflowd-task")
  })

  test("validates all local branches in one push", async () => {
    const result = await run(
      ["/bin/sh", validator],
      fixtureRepository,
      pushLine("refs/heads/feature/workflowd-feat-add-guard") +
        pushLine("refs/heads/not-a-ticket-branch"),
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("not-a-ticket-branch")
  })

  test("ignores deletion lines and non-branch refs", async () => {
    await rm(join(fixtureRoot, "bin", "bd"))
    const input =
      pushLine("refs/heads/not-a-ticket-branch", deletedSha) +
      pushLine("refs/tags/not-a-ticket-tag")

    const result = await run(["/bin/sh", validator], fixtureRepository, input)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
  })
})

test("hook installer configures only the fixture repository", async () => {
  const install = await run(["/bin/sh", installer], fixtureRepository)
  expect(install.status).toBe(0)

  const configuredPath = await run(
    ["git", "config", "--local", "--get", "core.hooksPath"],
    fixtureRepository,
  )
  expect(configuredPath.status).toBe(0)
  expect(configuredPath.stdout.trim()).toBe(".githooks")
})

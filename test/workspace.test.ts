import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Deferred, Effect, Fiber, Logger, Schema } from "effect"
import { FixResult } from "../src/domain/fix-result"
import { ReviewResult } from "../src/domain/review-result"
import { FixWork, ReviewWork } from "../src/domain/work"
import { GitWorkspaceAdapter } from "../src/workspace"
import { runWorkspaceCommand } from "../src/workspace/command"

const temporaryDirectories = new Set<string>()

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  )
  temporaryDirectories.clear()
})

function captureLogs<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  logs: Array<{ readonly level: string; readonly message: unknown }>,
): Effect.Effect<A, E, R> {
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    logs.push({ level: logLevel.label, message })
  })
  return effect.pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger)))
}

async function git(cwd: string, ...args: ReadonlyArray<string>): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (status !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}

async function createRepositoryFixture(prefix: string) {
  const root = await temporaryDirectory(prefix)
  const remote = join(root, "remote.git")
  const source = join(root, "source")
  await mkdir(remote, { recursive: true })
  await mkdir(source, { recursive: true })
  await git(remote, "init", "--bare")
  await git(source, "init", "-b", "main")
  await git(source, "config", "user.email", "test@example.com")
  await git(source, "config", "user.name", "Test")
  await writeFile(join(source, "app.ts"), "export const value = 1\n")
  await git(source, "add", "app.ts")
  await git(source, "commit", "-m", "base")
  const baseSha = await git(source, "rev-parse", "HEAD")
  await git(source, "remote", "add", "origin", remote)
  await git(source, "push", "-u", "origin", "main")
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
  await git(source, "switch", "-c", "feature")
  await writeFile(join(source, "app.ts"), "export const value = 2\n")
  await git(source, "commit", "-am", "change")
  await git(source, "push", "-u", "origin", "feature")
  const headSha = await git(source, "rev-parse", "HEAD")
  await git(remote, "update-ref", "refs/pull/7/head", headSha)
  return { root, remote, source, baseSha, headSha }
}

function makeReviewJob(
  fixture: Awaited<ReturnType<typeof createRepositoryFixture>>,
  overrides: {
    readonly id?: number
    readonly repositoryFullName?: string
    readonly author?: string
    readonly baseRef?: string
    readonly baseSha?: string
    readonly expectedHeadSha?: string
    readonly headRef?: string
    readonly headRepositoryFullName?: string
    readonly generation?: number
    readonly attempt?: number
  } = {},
): ReviewWork {
  return Schema.decodeUnknownSync(ReviewWork)({
    _tag: "ReviewWork",
    id: overrides.id ?? 11,
    installationId: 91,
    repositoryId: 42,
    repositoryFullName: overrides.repositoryFullName ?? "example-owner/example",
    pullRequestNumber: 7,
    author: overrides.author ?? "opencode-agent",
    target: {
      baseRef: overrides.baseRef ?? "main",
      baseSha: overrides.baseSha ?? fixture.baseSha,
      headSha: overrides.expectedHeadSha ?? fixture.headSha,
      headRef: overrides.headRef ?? "feature",
      headRepositoryFullName: overrides.headRepositoryFullName ?? "example-owner/example",
    },
    generation: overrides.generation ?? 1,
    reviewRequestNumber: 1,
    workerId: "workspace-test",
    attempt: overrides.attempt ?? 1,
  })
}

function makeFixJob(
  fixture: Awaited<ReturnType<typeof createRepositoryFixture>>,
  overrides: {
    readonly id?: number
    readonly author?: string
    readonly expectedHeadSha?: string
    readonly generation?: number
    readonly attempt?: number
    readonly review?: typeof FixWork.Encoded.review
    readonly checkpoint?: FixResult
  } = {},
): FixWork {
  return Schema.decodeUnknownSync(FixWork)({
    _tag: "FixWork",
    id: overrides.id ?? 11,
    installationId: 91,
    repositoryId: 42,
    repositoryFullName: "example-owner/example",
    pullRequestNumber: 7,
    author: overrides.author ?? "opencode-agent",
    target: {
      baseRef: "main",
      baseSha: fixture.baseSha,
      headSha: overrides.expectedHeadSha ?? fixture.headSha,
      headRef: "feature",
      headRepositoryFullName: "example-owner/example",
    },
    generation: overrides.generation ?? 1,
    reviewRequestNumber: 1,
    workerId: "workspace-test",
    attempt: overrides.attempt ?? 1,
    sourcePublicationId: 31,
    review: overrides.review ?? {
      verdict: "changes_requested",
      summary: "One issue.",
      findings: [{ severity: "high", title: "Bug", body: "Fix it." }],
    },
    ...(overrides.checkpoint === undefined ? {} : { checkpoint: overrides.checkpoint }),
  })
}

function makeManager(
  fixture: Awaited<ReturnType<typeof createRepositoryFixture>>,
  localRepositories: ReadonlyArray<string>,
  worktreeRegistry?: string,
  maxDiffBytes = 1_000_000,
) {
  return new GitWorkspaceAdapter({
    localRepositories,
    ...(worktreeRegistry === undefined ? {} : { worktreeRegistry }),
    repositoryRoot: join(fixture.root, "repositories"),
    worktreeRoot: join(fixture.root, "worktrees"),
    remoteUrl: () => fixture.remote,
    maxDiffBytes,
  })
}

const fixResult = (input: typeof FixResult.Encoded) => Schema.decodeUnknownSync(FixResult)(input)

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The process has already exited.
    }
  }
}

test("interrupting a workspace command terminates and reaps its process group", async () => {
  const root = await temporaryDirectory("workflowd-command-")
  const parentFile = join(root, "parent.pid")
  const childFile = join(root, "child.pid")
  const fiber = Effect.runFork(
    runWorkspaceCommand("block for test", [
      "bash",
      "-c",
      'printf "%s" "$$" > "$1"; (trap "" TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & printf "%s" "$!" > "$2"; wait',
      "_",
      parentFile,
      childFile,
    ]),
  )

  await waitForPath(parentFile)
  await waitForPath(childFile)
  const parentPid = Number(await readFile(parentFile, "utf8"))
  const childPid = Number(await readFile(childFile, "utf8"))
  try {
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(processIsAlive(parentPid)).toBe(false)
    expect(processIsAlive(childPid)).toBe(false)
  } finally {
    killProcessGroup(parentPid)
    if (processIsAlive(childPid)) process.kill(childPid, "SIGKILL")
  }
})

describe("GitWorkspaceAdapter", () => {
  test("constructs the workspace port as a concrete Git adapter", async () => {
    const fixture = await createRepositoryFixture("workflowd-adapter-")

    expect(makeManager(fixture, [])).toBeInstanceOf(GitWorkspaceAdapter)
  })

  test("pulls and prepares a fix in an existing local worktree", async () => {
    const fixture = await createRepositoryFixture("workflowd-worktree-")
    const worktree = join(fixture.root, "existing-worktree")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    await writeFile(join(fixture.source, "app.ts"), "export const value = 3\n")
    await git(fixture.source, "commit", "-am", "latest change")
    await git(fixture.source, "push", "origin", "feature")
    const headSha = await git(fixture.source, "rev-parse", "HEAD")
    await git(fixture.remote, "update-ref", "refs/pull/7/head", headSha)
    const registry = join(fixture.root, "registry")
    await mkdir(registry)
    await writeFile(
      join(registry, "job.json"),
      JSON.stringify({
        github_repository: "example-owner/example",
        branch: "feature",
        worktree,
      }),
    )

    const manager = makeManager(fixture, [fixture.root], registry)
    const job = makeFixJob(fixture, {
      expectedHeadSha: headSha,
      review: {
        verdict: "changes_requested",
        summary: "One issue.",
        findings: [{ severity: "high", title: "Bug", body: "Fix the bug." }],
      },
    })

    const prepared = await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.flatMap((workspace) =>
            Effect.promise(async () => ({
              diff: await readFile(join(workspace.directory, ".workflowd/review.diff"), "utf8"),
              directory: workspace.directory,
              head: await git(workspace.directory, "rev-parse", "HEAD"),
              review: Schema.decodeUnknownSync(Schema.parseJson(ReviewResult))(
                await readFile(join(workspace.directory, ".workflowd/review.json"), "utf8"),
              ),
            })),
          ),
        ),
      ),
    )

    expect(prepared.directory).toBe(worktree)
    expect(prepared.head).toBe(headSha)
    expect(prepared.diff).toContain("+export const value = 3")
    expect(prepared.diff).not.toEndWith("\n")
    expect(prepared.review).toMatchObject({ verdict: "changes_requested" })
    expect((await stat(worktree)).isDirectory()).toBe(true)
    await expect(stat(join(worktree, ".workflowd"))).rejects.toThrow()
  })

  test("never deletes an unowned .workflowd directory", async () => {
    const fixture = await createRepositoryFixture("workflowd-owned-context-")
    const worktree = join(fixture.root, "worktree")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    await mkdir(join(worktree, ".workflowd"))
    const userFile = join(worktree, ".workflowd/user.txt")
    await writeFile(userFile, "keep me\n")
    const manager = makeManager(fixture, [worktree])
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []

    await expect(
      Effect.runPromise(
        captureLogs(Effect.scoped(manager.prepareReview(makeReviewJob(fixture, { id: 12 }))), logs),
      ),
    ).rejects.toThrow()
    expect(await readFile(userFile, "utf8")).toBe("keep me\n")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      level: "WARN",
      message: [{ operation: "remove review context" }],
    })
  })

  test("does not release a worktree permit when an interrupted waiter never acquired it", async () => {
    const fixture = await createRepositoryFixture("workflowd-lock-")
    const worktree = join(fixture.root, "worktree")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    const manager = makeManager(fixture, [worktree])
    const job = makeReviewJob(fixture)

    await Effect.runPromise(
      Effect.gen(function* () {
        const releaseA = yield* Deferred.make<void>()
        const enteredA = yield* Deferred.make<void>()
        const enteredC = yield* Deferred.make<void>()
        const releaseC = yield* Deferred.make<void>()
        const a = yield* Effect.fork(
          Effect.scoped(
            manager.prepareReview(job).pipe(
              Effect.tap(() => Deferred.succeed(enteredA, undefined)),
              Effect.zipRight(Deferred.await(releaseA)),
            ),
          ),
        )
        yield* Deferred.await(enteredA)
        const b = yield* Effect.fork(Effect.scoped(manager.prepareReview(job)))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(b)
        const c = yield* Effect.fork(
          Effect.scoped(
            manager.prepareReview(job).pipe(
              Effect.tap(() => Deferred.succeed(enteredC, undefined)),
              Effect.zipRight(Deferred.await(releaseC)),
            ),
          ),
        )
        yield* Effect.sleep("100 millis")
        expect((yield* Deferred.poll(enteredC))._tag).toBe("None")
        yield* Deferred.succeed(releaseA, undefined)
        yield* Deferred.await(enteredC)
        yield* Deferred.succeed(releaseC, undefined)
        yield* Fiber.join(a)
        yield* Fiber.join(c)
      }),
    )
  })

  test("discovers a local repository created after the catalog snapshot", async () => {
    const fixture = await createRepositoryFixture("workflowd-catalog-refresh-")
    const localRoot = join(fixture.root, "local")
    const appearedLater = join(localRoot, "appeared-later")
    await mkdir(localRoot)
    const manager = makeManager(fixture, [localRoot])

    const fallback = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )
    await git(localRoot, "clone", "--branch", "feature", fixture.remote, appearedLater)
    const discovered = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture, { generation: 2 }))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )

    expect(fallback).not.toBe(appearedLater)
    expect(discovered).toBe(appearedLater)
  })

  test("skips malformed registry files and uses a ready entry", async () => {
    const fixture = await createRepositoryFixture("workflowd-registry-json-")
    const worktree = join(fixture.root, "ready-worktree")
    const registry = join(fixture.root, "registry")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    await mkdir(registry)
    await writeFile(join(registry, "a-malformed.json"), "{not json")
    await writeFile(
      join(registry, "b-ready.json"),
      JSON.stringify({
        github_repository: "example-owner/example",
        branch: "feature",
        worktree,
        state: "ready",
      }),
    )
    const manager = makeManager(fixture, [], registry)

    const directory = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )

    expect(directory).toBe(worktree)
  })

  test("reads newly-created registry entries on every job", async () => {
    const fixture = await createRepositoryFixture("workflowd-registry-live-")
    const worktree = join(fixture.root, "ready-worktree")
    const registry = join(fixture.root, "registry")
    await mkdir(registry)
    const manager = makeManager(fixture, [], registry)

    const fallback = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    await writeFile(
      join(registry, "ready.json"),
      JSON.stringify({
        github_repository: "example-owner/example",
        branch: "feature",
        worktree,
        state: "ready",
      }),
    )
    const registered = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture, { generation: 2 }))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )

    expect(fallback).not.toBe(worktree)
    expect(registered).toBe(worktree)
  })

  test("does not select a registry entry whose state is not ready", async () => {
    const fixture = await createRepositoryFixture("workflowd-registry-state-")
    const runningWorktree = join(fixture.root, "running-worktree")
    const registry = join(fixture.root, "registry")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, runningWorktree)
    await mkdir(registry)
    await writeFile(
      join(registry, "running.json"),
      JSON.stringify({
        github_repository: "example-owner/example",
        branch: "feature",
        worktree: runningWorktree,
        state: "running",
      }),
    )
    const manager = makeManager(fixture, [], registry)

    const directory = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )

    expect(directory).not.toBe(runningWorktree)
  })

  test("reads the registry while holding the cleanup lock", async () => {
    const fixture = await createRepositoryFixture("workflowd-registry-lock-")
    const worktree = join(fixture.root, "ready-worktree")
    const registry = join(fixture.root, "registry")
    const lock = join(registry, ".cleanup.lock")
    const locked = join(fixture.root, "locked")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    await mkdir(registry)
    await writeFile(lock, "")
    await writeFile(
      join(registry, "ready.json"),
      JSON.stringify({
        github_repository: "example-owner/example",
        branch: "feature",
        worktree,
        state: "ready",
      }),
    )
    const holder = Bun.spawn(
      ["flock", "--exclusive", lock, "bash", "-c", 'printf locked > "$1"; sleep 300', "_", locked],
      { detached: true, stderr: "pipe", stdout: "pipe" },
    )
    await waitForPath(locked)
    const manager = makeManager(fixture, [], registry)
    const fiber = Effect.runFork(Effect.scoped(manager.prepareReview(makeReviewJob(fixture))))
    await Bun.sleep(100)
    const beforeUnlock = await Effect.runPromise(Fiber.poll(fiber))
    killProcessGroup(holder.pid)
    await holder.exited
    await Effect.runPromise(Fiber.join(fiber))

    expect(beforeUnlock._tag).toBe("None")
  })

  test("keeps controller context out of git add -A and restores a clean worktree", async () => {
    const fixture = await createRepositoryFixture("workflowd-exclude-")
    const worktree = join(fixture.root, "worktree")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    const manager = makeManager(fixture, [worktree])

    const stagedDuringReview = await Effect.runPromise(
      Effect.scoped(
        manager.prepareReview(makeReviewJob(fixture)).pipe(
          Effect.flatMap((workspace) =>
            Effect.promise(async () => {
              await git(workspace.directory, "add", "-A")
              return git(workspace.directory, "status", "--porcelain", "--", ".workflowd")
            }),
          ),
        ),
      ),
    )

    expect(stagedDuringReview).toBe("")
    expect(await git(worktree, "ls-files", "--", ".workflowd")).toBe("")
    expect(await git(worktree, "status", "--porcelain")).toBe("")
  })

  test("never deletes controller context after it becomes tracked", async () => {
    const fixture = await createRepositoryFixture("workflowd-tracked-context-")
    const worktree = join(fixture.root, "worktree")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    const manager = makeManager(fixture, [worktree])
    const marker = join(worktree, ".workflowd", ".managed-by-workflowd")
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []

    await Effect.runPromise(
      captureLogs(
        Effect.scoped(
          manager
            .prepareReview(makeReviewJob(fixture))
            .pipe(
              Effect.flatMap((workspace) =>
                Effect.promise(() => git(workspace.directory, "add", "-f", ".workflowd")),
              ),
            ),
        ),
        logs,
      ),
    )

    expect(await readFile(marker, "utf8")).toBe("workflowd:v1\n")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      level: "WARN",
      message: [{ operation: "remove review context" }],
    })
  })

  test("disables Git hooks while pulling an existing worktree", async () => {
    const fixture = await createRepositoryFixture("workflowd-pull-hooks-")
    const worktree = join(fixture.root, "worktree")
    const hookOutput = join(worktree, "hook-ran")
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    const hook = join(worktree, ".git", "hooks", "post-merge")
    await writeFile(hook, `#!/usr/bin/env bash\nprintf hook > ${JSON.stringify(hookOutput)}\n`, {
      mode: 0o700,
    })
    await writeFile(join(fixture.source, "app.ts"), "export const value = 3\n")
    await git(fixture.source, "commit", "-am", "latest change")
    await git(fixture.source, "push", "origin", "feature")
    const headSha = await git(fixture.source, "rev-parse", "HEAD")
    await git(fixture.remote, "update-ref", "refs/pull/7/head", headSha)
    const manager = makeManager(fixture, [worktree])

    await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture, { expectedHeadSha: headSha }))),
    )

    await expect(stat(hookOutput)).rejects.toThrow()
    expect(await git(worktree, "status", "--porcelain")).toBe("")
  })

  test("managed fallback fetches the same-repository head branch", async () => {
    const fixture = await createRepositoryFixture("workflowd-managed-fetch-")
    const repository = join(fixture.root, "repositories", "github.com", "example-owner", "example")
    await mkdir(dirname(repository), { recursive: true })
    await git(fixture.root, "clone", fixture.remote, repository)
    await git(repository, "update-ref", "-d", "refs/remotes/origin/feature")
    const manager = makeManager(fixture, [])

    const directory = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )

    expect(directory).toBe(join(fixture.root, "worktrees", "42", "7", "11-1"))
    expect(await git(repository, "rev-parse", "refs/remotes/origin/feature")).toBe(fixture.headSha)
  })

  test("managed fallback recovers a missing controller worktree registration", async () => {
    const fixture = await createRepositoryFixture("workflowd-managed-recover-")
    const repository = join(fixture.root, "repositories", "github.com", "example-owner", "example")
    const directory = join(fixture.root, "worktrees", "42", "7", "11-1")
    await mkdir(dirname(repository), { recursive: true })
    await mkdir(dirname(directory), { recursive: true })
    await git(fixture.root, "clone", fixture.remote, repository)
    await git(repository, "worktree", "add", "-b", "feature", directory, "origin/feature")
    await rm(directory, { recursive: true, force: true })
    const manager = makeManager(fixture, [])

    const preparedDirectory = await Effect.runPromise(
      Effect.scoped(manager.prepareReview(makeReviewJob(fixture))).pipe(
        Effect.map((workspace) => workspace.directory),
      ),
    )

    expect(preparedDirectory).toBe(directory)
    expect(await git(repository, "worktree", "list", "--porcelain")).not.toContain(directory)
  })

  test("managed setup failure does not strand a worktree", async () => {
    const fixture = await createRepositoryFixture("workflowd-managed-failure-")
    const repository = join(fixture.root, "repositories", "github.com", "example-owner", "example")
    const directory = join(fixture.root, "worktrees", "42", "7", "11-1")
    await mkdir(dirname(repository), { recursive: true })
    await git(fixture.root, "clone", fixture.remote, repository)
    await git(repository, "update-ref", "-d", "refs/remotes/origin/feature")
    await git(fixture.remote, "update-ref", "-d", "refs/heads/feature")
    const manager = makeManager(fixture, [])

    await expect(
      Effect.runPromise(Effect.scoped(manager.prepareReview(makeReviewJob(fixture)))),
    ).rejects.toThrow()

    expect(await git(repository, "worktree", "list", "--porcelain")).not.toContain(directory)
    await expect(stat(directory)).rejects.toThrow()
  })

  test("retains at most maxDiffBytes from a large Git diff", async () => {
    const fixture = await createRepositoryFixture("workflowd-large-diff-")
    const worktree = join(fixture.root, "worktree")
    const maxDiffBytes = 8_192
    await writeFile(join(fixture.source, "large.txt"), "large diff line\n".repeat(250_000))
    await git(fixture.source, "add", "large.txt")
    await git(fixture.source, "commit", "-m", "large diff")
    await git(fixture.source, "push", "origin", "feature")
    const headSha = await git(fixture.source, "rev-parse", "HEAD")
    await git(fixture.remote, "update-ref", "refs/pull/7/head", headSha)
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    const manager = makeManager(fixture, [worktree], undefined, maxDiffBytes)

    const diff = await Effect.runPromise(
      Effect.scoped(
        manager
          .prepareReview(makeReviewJob(fixture, { expectedHeadSha: headSha }))
          .pipe(
            Effect.flatMap((workspace) =>
              Effect.promise(() => readFile(join(workspace.directory, ".workflowd/review.diff"))),
            ),
          ),
      ),
    )

    expect(diff.byteLength).toBe(
      maxDiffBytes + Buffer.byteLength("\n\n[diff truncated by workflowd]\n"),
    )
    expect(diff.subarray(0, maxDiffBytes).every((byte) => byte !== 0)).toBe(true)
    expect(diff.toString("utf8")).toEndWith("[diff truncated by workflowd]\n")
  })

  test("context creation is not exposed until all context files are ready", async () => {
    const fixture = await createRepositoryFixture("workflowd-context-atomic-")
    const worktree = join(fixture.root, "worktree")
    const textconv = join(fixture.root, "blocking-textconv")
    const started = join(fixture.root, "textconv-started")
    const textconvPid = join(fixture.root, "textconv.pid")
    await writeFile(join(fixture.source, ".gitattributes"), "*.bin diff=blocking\n")
    await writeFile(join(fixture.source, "value.bin"), "base\n")
    await git(fixture.source, "switch", "main")
    await git(fixture.source, "add", ".gitattributes", "value.bin")
    await git(fixture.source, "commit", "-m", "binary base")
    const baseSha = await git(fixture.source, "rev-parse", "HEAD")
    await git(fixture.source, "push", "origin", "main")
    await git(fixture.source, "switch", "feature")
    await git(fixture.source, "merge", "main")
    await writeFile(join(fixture.source, "value.bin"), "feature\n")
    await git(fixture.source, "commit", "-am", "binary change")
    await git(fixture.source, "push", "origin", "feature")
    const headSha = await git(fixture.source, "rev-parse", "HEAD")
    await git(fixture.remote, "update-ref", "refs/pull/7/head", headSha)
    await git(fixture.root, "clone", "--branch", "feature", fixture.remote, worktree)
    await writeFile(
      textconv,
      `#!/usr/bin/env bash\nprintf "%s" "$$" > ${JSON.stringify(textconvPid)}\nprintf started > ${JSON.stringify(started)}\nexec sleep 300\n`,
      { mode: 0o700 },
    )
    await git(worktree, "config", "diff.blocking.textconv", textconv)
    const manager = makeManager(fixture, [worktree])
    const fiber = Effect.runFork(
      Effect.scoped(
        manager.prepareReview(makeReviewJob(fixture, { baseSha, expectedHeadSha: headSha })),
      ),
    )

    await waitForPath(started)
    const contextExistsDuringCreation = await stat(join(worktree, ".workflowd")).then(
      () => true,
      () => false,
    )
    await Effect.runPromise(Fiber.interrupt(fiber))
    const pid = Number(await readFile(textconvPid, "utf8"))
    if (processIsAlive(pid)) process.kill(pid, "SIGKILL")

    expect(contextExistsDuringCreation).toBe(false)
    expect((await readdir(worktree)).filter((entry) => entry.startsWith(".workflowd"))).toEqual([])
  })

  test("retains edits from a failed fix attempt for the next attempt", async () => {
    const fixture = await createRepositoryFixture("workflowd-fix-edit-")
    const manager = makeManager(fixture, [])
    const job = makeFixJob(fixture, {
      review: {
        verdict: "changes_requested",
        summary: "One issue.",
        findings: [{ severity: "high", title: "Bug", body: "Fix it." }],
      },
    })

    await Effect.runPromise(
      Effect.scoped(
        manager
          .prepareFix(job)
          .pipe(
            Effect.flatMap((workspace) =>
              Effect.promise(() =>
                writeFile(join(workspace.directory, "app.ts"), "export const value = 3\n"),
              ),
            ),
          ),
      ),
    )
    const recovered = await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.flatMap((workspace) =>
            Effect.promise(async () => ({
              contents: await readFile(join(workspace.directory, "app.ts"), "utf8"),
              recovery: workspace.recovery,
            })),
          ),
        ),
      ),
    )

    expect(recovered).toEqual({
      contents: "export const value = 3\n",
      recovery: "none",
    })
  })

  test("recovers and pushes a job-owned commit after failure before push", async () => {
    const fixture = await createRepositoryFixture("workflowd-fix-commit-")
    const manager = makeManager(fixture, [])
    const job = makeFixJob(fixture, {
      review: {
        verdict: "changes_requested",
        summary: "One issue.",
        findings: [{ severity: "high", title: "Bug", body: "Fix it." }],
      },
    })
    let commitSha = ""

    await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.flatMap((workspace) =>
            Effect.promise(async () => {
              await writeFile(join(workspace.directory, "app.ts"), "export const value = 3\n")
              await git(workspace.directory, "add", "app.ts")
              await git(
                workspace.directory,
                "commit",
                "-m",
                `fix value\n\nWorkflowd-Job: ${job.id}`,
              )
              commitSha = await git(workspace.directory, "rev-parse", "HEAD")
            }),
          ),
        ),
      ),
    )

    const recovery = await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.tap((workspace) =>
            manager.publishFix(job, workspace, undefined, () => Effect.succeed(true)),
          ),
          Effect.tap((workspace) => Effect.sync(() => workspace.markCompleted())),
          Effect.map((workspace) => workspace.recovery),
        ),
      ),
    )

    expect(recovery).toBe("committed")
    expect(await git(fixture.remote, "rev-parse", "refs/heads/feature")).toBe(commitSha)
  })

  test("recognizes the same job after push but before store completion", async () => {
    const fixture = await createRepositoryFixture("workflowd-fix-pushed-")
    const manager = makeManager(fixture, [])
    const job = makeFixJob(fixture, {
      review: {
        verdict: "changes_requested",
        summary: "One issue.",
        findings: [{ severity: "high", title: "Bug", body: "Fix it." }],
      },
    })
    let commitSha = ""

    await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.flatMap((workspace) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                writeFile(join(workspace.directory, "app.ts"), "export const value = 4\n"),
              )
              yield* Effect.promise(() => git(workspace.directory, "add", "app.ts"))
              yield* Effect.promise(() =>
                git(
                  workspace.directory,
                  "commit",
                  "-m",
                  `fix before crash\n\nWorkflowd-Job: ${job.id}`,
                ),
              )
              commitSha = yield* Effect.promise(() => git(workspace.directory, "rev-parse", "HEAD"))
              yield* manager.publishFix(
                job,
                workspace,
                fixResult({
                  _tag: "CommitPrepared",
                  summary: "Committed the fix.",
                  commitSha,
                }),
                () => Effect.succeed(true),
              )
              // Simulate a crash before completeFixJob by not marking the workspace complete.
            }),
          ),
        ),
      ),
    )

    const recovery = await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.tap((workspace) =>
            manager.publishFix(job, workspace, undefined, () => Effect.succeed(true)),
          ),
          Effect.tap((workspace) => Effect.sync(() => workspace.markCompleted())),
          Effect.map((workspace) => workspace.recovery),
        ),
      ),
    )

    expect(recovery).toBe("pushed")
    expect(await git(fixture.remote, "rev-parse", "refs/heads/feature")).toBe(commitSha)
  })

  test("rejects a structured fix result with the wrong commit SHA", async () => {
    const fixture = await createRepositoryFixture("workflowd-fix-wrong-sha-")
    const manager = makeManager(fixture, [])
    const job = makeFixJob(fixture, {
      review: {
        verdict: "changes_requested",
        summary: "One issue.",
        findings: [{ severity: "high", title: "Bug", body: "Fix it." }],
      },
    })

    const exit = await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.flatMap((workspace) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                writeFile(join(workspace.directory, "app.ts"), "export const value = 5\n"),
              )
              yield* Effect.promise(() => git(workspace.directory, "add", "app.ts"))
              yield* Effect.promise(() =>
                git(
                  workspace.directory,
                  "commit",
                  "-m",
                  `wrong report\n\nWorkflowd-Job: ${job.id}`,
                ),
              )
              return yield* Effect.exit(
                manager.publishFix(
                  job,
                  workspace,
                  fixResult({
                    _tag: "CommitPrepared",
                    summary: "Reported the wrong SHA.",
                    commitSha: "f".repeat(40),
                  }),
                  () => Effect.succeed(true),
                ),
              )
            }),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(await git(fixture.remote, "rev-parse", "refs/heads/feature")).toBe(fixture.headSha)
  })

  test("does not push when durable Fix Work currentness is revoked", async () => {
    const fixture = await createRepositoryFixture("workflowd-fix-currentness-")
    const manager = makeManager(fixture, [])
    const job = makeFixJob(fixture)

    const exit = await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.flatMap((workspace) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                writeFile(join(workspace.directory, "app.ts"), "export const value = 6\n"),
              )
              yield* Effect.promise(() => git(workspace.directory, "add", "app.ts"))
              yield* Effect.promise(() =>
                git(workspace.directory, "commit", "-m", `revoked fix\n\nWorkflowd-Job: ${job.id}`),
              )
              return yield* Effect.exit(
                manager.publishFix(job, workspace, undefined, () => Effect.succeed(false)),
              )
            }),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(await git(fixture.remote, "rev-parse", "refs/heads/feature")).toBe(fixture.headSha)
  })

  test("accepts NoChanges only while local and remote state are unchanged", async () => {
    const fixture = await createRepositoryFixture("workflowd-fix-no-change-")
    const manager = makeManager(fixture, [])
    const job = makeFixJob(fixture, {
      review: {
        verdict: "changes_requested",
        summary: "One issue.",
        findings: [{ severity: "high", title: "Bug", body: "Check it." }],
      },
    })
    const noChanges = {
      _tag: "NoChanges" as const,
      summary: "The requested state is already present.",
    }

    const accepted = await Effect.runPromise(
      Effect.scoped(
        manager.prepareFix(job).pipe(
          Effect.tap((workspace) =>
            manager.publishFix(job, workspace, noChanges, () => Effect.succeed(true)),
          ),
          Effect.tap((workspace) => Effect.sync(() => workspace.markCompleted())),
          Effect.as("accepted" as const),
        ),
      ),
    )

    const changedExit = await Effect.runPromise(
      Effect.scoped(
        manager
          .prepareFix(job)
          .pipe(
            Effect.flatMap((workspace) =>
              Effect.promise(() => writeFile(join(workspace.directory, "app.ts"), "dirty\n")).pipe(
                Effect.andThen(
                  Effect.exit(
                    manager.publishFix(job, workspace, noChanges, () => Effect.succeed(true)),
                  ),
                ),
              ),
            ),
          ),
      ),
    )

    expect(accepted).toBe("accepted")
    expect(changedExit._tag).toBe("Failure")
  })
})

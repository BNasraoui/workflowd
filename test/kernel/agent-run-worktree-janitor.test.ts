import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Logger } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { agentRunIdentifiers, type AgentRunProviderPort } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import {
  AgentRunWorktreeJanitor,
  AgentRunWorktreeJanitorLive,
} from "../../src/kernel/agent-run-worktree-janitor"
import { gitAgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import { AgentWaitCustodyError, AgentWaitIngress } from "../../src/kernel/agent-wait-ingress"
import { KernelJobStoreLive } from "../../src/kernel/job-store"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { McpQueries, McpQueriesLive } from "../../src/mcp/queries"
import { at, makeLayer, register } from "./agent-run-ingress-harness"

const RETENTION_MS = 2 * 24 * 60 * 60_000
const afterRetention = new Date(at.getTime() + RETENTION_MS + 1)

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

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** Every dispatched session is a distinct child that has produced output. */
const provider = (): AgentRunProviderPort => {
  let sessions = 0
  return {
    createSession: () => Effect.sync(() => ({ id: `ses_child_${++sessions}` })),
    promptSession: () => Effect.void,
    abortSession: () => Effect.succeed(true),
    listProviders: () => Effect.succeed(["zai-coding-plan"]),
    listModels: () => Effect.succeed([{ providerID: "zai-coding-plan", id: "glm-5.3-flash" }]),
    sessionTelemetry: () =>
      Effect.succeed({ directory: "", outputTokens: 7, updatedAtMs: at.getTime(), idle: false }),
  }
}

const testLayer = (
  repositories: ReadonlyArray<{ readonly name: string; readonly directory: string }>,
  worktreeRoot: string,
  now: () => Date,
  filename = ":memory:",
  batchSize = 20,
) =>
  Layer.merge(
    AgentRunWorktreeJanitorLive({
      owningHostId: "mint",
      worktreeRoot,
      repositories,
      retentionMs: RETENTION_MS,
      batchSize,
      now,
    }),
    McpQueriesLive.pipe(Layer.provide(KernelJobStoreLive)),
  ).pipe(
    Layer.provideMerge(
      makeLayer(
        provider(),
        gitAgentRunWorktrees,
        undefined,
        { repositories, worktreeRoot },
        undefined,
        filename,
      ),
    ),
  )

const withRepository = async <A>(
  run: (context: {
    readonly root: string
    readonly repository: string
    readonly layer: (
      now: () => Date,
      filename?: string,
      batchSize?: number,
    ) => ReturnType<typeof testLayer>
  }) => Promise<A>,
) => {
  const root = await mkdtemp(join(tmpdir(), "agent-run-janitor-"))
  try {
    const origin = join(root, "origin.git")
    const repository = join(root, "clone")
    await git(root, "init", "--bare", "--initial-branch=main", origin)
    await git(root, "clone", origin, repository)
    await git(repository, "config", "user.email", "test@example.invalid")
    await git(repository, "config", "user.name", "Test")
    await git(repository, "commit", "--allow-empty", "-m", "seed")
    await git(repository, "push", "-u", "origin", "main")
    const repositories = [{ name: "fixture", directory: repository }]
    const layer = (now: () => Date, filename?: string, batchSize?: number) =>
      testLayer(repositories, join(root, "worktrees"), now, filename, batchSize)
    return await run({ root, repository, layer })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const dispatch = (prompt: string) =>
  Effect.gen(function* () {
    const receipt = yield* register({ route: "implement", repository: "fixture", prompt })
    const run = yield* (yield* AgentRunStore).read(receipt.runId)
    const short = agentRunIdentifiers({
      route: "implement",
      repository: "fixture",
      prompt,
      parentSessionId: null,
      resumePrompt: null,
    }).short
    return {
      runId: receipt.runId,
      sessionId: run!.sessionId!,
      mailboxId: receipt.mailboxId,
      directory: run!.directory,
      branch: `agent-run/${short}`,
    }
  })

/** Runs janitor iterations until it reports no more work. */
const drain = Effect.gen(function* () {
  const janitor = yield* AgentRunWorktreeJanitor
  for (let iteration = 0; iteration < 20; iteration += 1)
    if ((yield* janitor.iteration) === "idle") return
  throw new Error("janitor never became idle")
})

const worktreeOf = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* (yield* McpQueries).listAgentRuns({ limit: 100 })
    const run = runs.find((candidate) => candidate.run_id === runId)
    return { worktree: run?.worktree, detail: run?.worktree_detail }
  })

const captureWarnings = (warnings: Array<string>) =>
  Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message))
    }),
  ])

describe("agent-run worktree janitor", () => {
  test("removes a terminal run's worktree once retention passes and keeps its branch", () =>
    withRepository(async ({ repository, layer }) => {
      let now = at
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("finished work")
          yield* (yield* AgentRunStore).complete({ runId: run.runId, now: at })
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "present", detail: null })

          now = new Date(at.getTime() + RETENTION_MS - 1)
          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(true)

          now = afterRetention
          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(false)
          const listed = yield* Effect.promise(() =>
            git(repository, "worktree", "list", "--porcelain"),
          )
          expect(listed).not.toContain(run.directory)
          expect(
            yield* Effect.promise(() => git(repository, "branch", "--list", run.branch)),
          ).toContain(run.branch)
          expect(yield* worktreeOf(run.runId)).toEqual({
            worktree: "removed",
            detail: null,
          })
        }).pipe(Effect.provide(layer(() => now))),
      )
    }))

  test("keeps a dirty or locked worktree and reports it once", () =>
    withRepository(async ({ repository, layer }) => {
      const warnings: Array<string> = []
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AgentRunStore
          const dirty = yield* dispatch("left notes behind")
          const locked = yield* dispatch("locked by an operator")
          yield* store.complete({ runId: dirty.runId, now: at })
          yield* store.cancel({ runId: locked.runId, now: at })
          yield* Effect.promise(() => writeFile(join(dirty.directory, "notes.txt"), "keep me\n"))
          yield* Effect.promise(() => git(repository, "worktree", "lock", locked.directory))

          yield* drain
          yield* drain

          expect(yield* Effect.promise(() => exists(join(dirty.directory, "notes.txt")))).toBe(true)
          expect(yield* Effect.promise(() => exists(locked.directory))).toBe(true)
          expect(yield* worktreeOf(dirty.runId)).toEqual({
            worktree: "retained",
            detail: "worktree has 1 uncommitted or untracked path",
          })
          expect(yield* worktreeOf(locked.runId)).toEqual({
            worktree: "retained",
            detail: "worktree is locked",
          })
          expect(warnings).toHaveLength(2)
          expect(warnings.some((warning) => warning.includes("uncommitted or untracked"))).toBe(
            true,
          )
          expect(warnings.some((warning) => warning.includes("worktree is locked"))).toBe(true)
        }).pipe(
          Effect.provide(layer(() => afterRetention)),
          Effect.provide(captureWarnings(warnings)),
        ),
      )
    }))

  test("never touches the worktree of a run that has not ended", () =>
    withRepository(async ({ layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("still working")
          expect((yield* (yield* AgentRunStore).read(run.runId))?.state).toBe("verified")
          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(true)
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "present", detail: null })
        }).pipe(Effect.provide(layer(() => new Date(at.getTime() + 10 * RETENTION_MS)))),
      )
    }))

  test("refuses a cleanup request for the repository checkout", () =>
    withRepository(async ({ repository, layer }) => {
      const warnings: Array<string> = []
      await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* KernelSessionStore
          yield* sessions.registerResource({
            resourceId: "main-checkout",
            owningHostId: "mint",
            absolutePath: repository,
            kind: "worktree",
            createdAt: at,
          })
          yield* sessions.requestCleanup({
            cleanupId: "agent-run-worktree-main-checkout",
            resourceId: "main-checkout",
            owningHostId: "mint",
            reason: "misdirected",
            maxAttempts: 1,
            runAt: at,
            createdAt: at,
          })
          yield* drain
          expect(yield* Effect.promise(() => git(repository, "rev-parse", "HEAD"))).not.toBe("")
          expect((yield* sessions.readResource("main-checkout"))?.state).toBe("operator_required")
          expect(warnings).toEqual([
            "Agent-run worktree retained for an operator: resource is not an agent-run worktree",
          ])
        }).pipe(
          Effect.provide(layer(() => afterRetention)),
          Effect.provide(captureWarnings(warnings)),
        ),
      )
    }))

  test("catches up after a restart on runs that ended while the daemon was down", () =>
    withRepository(async ({ root, layer }) => {
      const database = join(root, "workflowd.sqlite")
      const run = await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("ended before shutdown")
          yield* (yield* AgentRunStore).complete({ runId: run.runId, now: at })
          return run
        }).pipe(Effect.provide(layer(() => at, database))),
      )
      expect(await exists(run.directory)).toBe(true)

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(false)
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "removed", detail: null })
        }).pipe(Effect.provide(layer(() => afterRetention, database))),
      )
    }))

  test("keeps the worktree of an operator_required run, whose process may still be alive", () =>
    withRepository(async ({ layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("custody lost")
          yield* (yield* AgentRunStore).operatorRequired({
            runId: run.runId,
            now: at,
            diagnostic: "codex_recovery_failed",
          })
          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(true)
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "present", detail: null })
        }).pipe(Effect.provide(layer(() => new Date(at.getTime() + 10 * RETENTION_MS)))),
      )
    }))

  test("refuses a run path that is a symlink to another linked worktree", () =>
    withRepository(async ({ repository, layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AgentRunStore
          const planted = yield* dispatch("path replaced by a symlink")
          const target = yield* dispatch("still working elsewhere")
          yield* store.complete({ runId: planted.runId, now: at })
          yield* Effect.promise(async () => {
            await git(repository, "worktree", "remove", planted.directory)
            await symlink(target.directory, planted.directory)
          })

          yield* drain

          expect(yield* Effect.promise(() => exists(target.directory))).toBe(true)
          expect(
            yield* Effect.promise(() => git(repository, "worktree", "list", "--porcelain")),
          ).toContain(target.directory)
          expect(yield* worktreeOf(planted.runId)).toEqual({
            worktree: "retained",
            detail: "directory is a symbolic link",
          })
        }).pipe(Effect.provide(layer(() => afterRetention))),
      )
    }))

  test("refuses directories that are not a linked worktree of the repository", () =>
    withRepository(async ({ root, repository, layer }) => {
      const other = join(root, "other")
      await git(root, "init", "--initial-branch=main", other)
      await git(
        other,
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=T",
        "commit",
        "--allow-empty",
        "-m",
        "seed",
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AgentRunStore
          const clone = yield* dispatch("replaced by a full clone")
          const foreign = yield* dispatch("replaced by another repository's worktree")
          const nested = yield* dispatch("replaced by a plain directory")
          for (const run of [clone, foreign, nested])
            yield* store.complete({ runId: run.runId, now: at })
          yield* Effect.promise(async () => {
            for (const run of [clone, foreign, nested])
              await git(repository, "worktree", "remove", run.directory)
            await git(root, "clone", "--quiet", repository, clone.directory)
            await git(other, "worktree", "add", "--quiet", foreign.directory)
            await mkdir(nested.directory)
            await writeFile(join(nested.directory, "notes.txt"), "keep me\n")
            // The agent-runs directory itself is a repository, so the plain
            // directory resolves to a work tree whose top level is its parent.
            await git(join(root, "worktrees", "agent-runs"), "init", "--quiet")
          })

          yield* drain

          for (const run of [clone, foreign, nested])
            expect(yield* Effect.promise(() => exists(run.directory))).toBe(true)
          expect(yield* Effect.promise(() => exists(join(nested.directory, "notes.txt")))).toBe(
            true,
          )
          expect(yield* worktreeOf(clone.runId)).toEqual({
            worktree: "retained",
            detail: "directory is a main checkout, not a linked worktree",
          })
          expect(yield* worktreeOf(foreign.runId)).toEqual({
            worktree: "retained",
            detail: "worktree belongs to a different repository",
          })
          expect(yield* worktreeOf(nested.runId)).toEqual({
            worktree: "retained",
            detail: "directory is not the top of a Git worktree",
          })
        }).pipe(Effect.provide(layer(() => afterRetention))),
      )
    }))

  test("marks a worktree that is already gone as missing", () =>
    withRepository(async ({ repository, layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("removed by hand")
          yield* (yield* AgentRunStore).cancel({ runId: run.runId, now: at })
          yield* Effect.promise(() => rm(run.directory, { recursive: true, force: true }))

          yield* drain

          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "missing", detail: null })
          expect(
            yield* Effect.promise(() => git(repository, "worktree", "list", "--porcelain")),
          ).not.toContain(run.directory)
        }).pipe(Effect.provide(layer(() => afterRetention))),
      )
    }))

  test("reclaims a lease left by a crash after removal without removing twice", () =>
    withRepository(async ({ repository, layer }) => {
      let now = afterRetention
      await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* KernelSessionStore
          const run = yield* dispatch("interrupted cleanup")
          yield* (yield* AgentRunStore).complete({ runId: run.runId, now: at })
          const resource = (yield* (yield* AgentRunStore).read(run.runId))!.resourceId!
          // A previous daemon requested and claimed the cleanup, removed the
          // worktree, and crashed before recording the outcome.
          yield* sessions.requestCleanup({
            cleanupId: `agent-run-worktree-${run.runId}`,
            resourceId: resource,
            owningHostId: "mint",
            reason: "retention elapsed",
            maxAttempts: 3,
            runAt: now,
            createdAt: now,
          })
          const crashed = yield* sessions.claimCleanup({
            owningHostId: "mint",
            workerId: "crashed-worker",
            now,
            leaseDurationMs: 5 * 60_000,
            cleanupIdPrefix: "agent-run-worktree-",
          })
          expect(crashed?.attempt).toBe(1)
          yield* Effect.promise(() => git(repository, "worktree", "remove", run.directory))

          yield* drain
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "removing", detail: null })

          now = new Date(afterRetention.getTime() + 5 * 60_000 + 1)
          yield* drain

          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "missing", detail: null })
          const sql = yield* SqlClient.SqlClient
          const attempts = yield* sql<{ readonly attempt: number; readonly state: string }>`
            SELECT attempt, state FROM kernel_cleanup_attempts
            WHERE cleanup_id = ${`agent-run-worktree-${run.runId}`} ORDER BY attempt`
          expect(attempts).toEqual([
            { attempt: 1, state: "leased" },
            { attempt: 2, state: "missing" },
          ])
        }).pipe(Effect.provide(layer(() => now))),
      )
    }))

  test("leaves cleanup requests that are not agent-run worktrees unclaimed", () =>
    withRepository(async ({ root, layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* KernelSessionStore
          yield* sessions.registerResource({
            resourceId: "other-workspace",
            owningHostId: "mint",
            absolutePath: join(root, "workspaces", "other"),
            kind: "workspace",
            createdAt: at,
          })
          yield* sessions.requestCleanup({
            cleanupId: "workspace-cleanup-other",
            resourceId: "other-workspace",
            owningHostId: "mint",
            reason: "another cleanup worker owns this",
            maxAttempts: 1,
            runAt: at,
            createdAt: at,
          })
          yield* drain
          expect((yield* sessions.readResource("other-workspace"))?.state).toBe("cleanup_required")
        }).pipe(Effect.provide(layer(() => afterRetention))),
      )
    }))

  test("checks a retained worktree again later and removes it once an operator fixed it", () =>
    withRepository(async ({ layer }) => {
      let now = afterRetention
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("fixed by an operator")
          yield* (yield* AgentRunStore).complete({ runId: run.runId, now: at })
          yield* Effect.promise(() => writeFile(join(run.directory, "notes.txt"), "keep me\n"))
          yield* drain
          expect((yield* worktreeOf(run.runId)).worktree).toBe("retained")

          yield* Effect.promise(() => rm(join(run.directory, "notes.txt")))
          now = new Date(afterRetention.getTime() + 60 * 60_000)
          yield* drain
          expect((yield* worktreeOf(run.runId)).worktree).toBe("retained")

          now = new Date(afterRetention.getTime() + 6 * 60 * 60_000)
          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(false)
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "removed", detail: null })
        }).pipe(Effect.provide(layer(() => now))),
      )
    }))

  test("times retention from the latest change to the run's session", () =>
    withRepository(async ({ layer }) => {
      let now = afterRetention
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("woken after it ended")
          yield* (yield* AgentRunStore).complete({ runId: run.runId, now: at })
          // A wake of the session after the run ended moves the session, not the run.
          const woken = new Date(at.getTime() + RETENTION_MS / 2)
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE kernel_sessions SET updated_at = ${woken.toISOString()}
            WHERE session_id = ${run.sessionId}`

          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(true)

          now = new Date(woken.getTime() + RETENTION_MS + 1)
          yield* drain
          expect(yield* Effect.promise(() => exists(run.directory))).toBe(false)
        }).pipe(Effect.provide(layer(() => now))),
      )
    }))

  test("keeps the worktree of a session that is the parent of an open wait_for_agent", () =>
    withRepository(async ({ layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const parent = yield* dispatch("waits for its child")
          const child = yield* dispatch("still running child")
          yield* (yield* AgentRunStore).complete({ runId: parent.runId, now: at })
          yield* (yield* AgentWaitIngress).register(
            {
              parentSessionId: parent.sessionId,
              childSessionId: child.sessionId,
              resumePrompt: "Continue once the child is done.",
            },
            at,
          )

          yield* drain

          expect(yield* Effect.promise(() => exists(parent.directory))).toBe(true)
          expect(yield* worktreeOf(parent.runId)).toEqual({ worktree: "present", detail: null })
        }).pipe(Effect.provide(layer(() => new Date(at.getTime() + 10 * RETENTION_MS)))),
      )
    }))

  test("refuses a late wait_for_agent on a cleaned session with its own reason", () =>
    withRepository(async ({ layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ended = yield* dispatch("ended long ago")
          const caller = yield* dispatch("asks too late")
          yield* (yield* AgentRunStore).complete({ runId: ended.runId, now: at })
          yield* drain
          expect((yield* worktreeOf(ended.runId)).worktree).toBe("removed")

          const error = yield* (yield* AgentWaitIngress)
            .register(
              {
                parentSessionId: caller.sessionId,
                childSessionId: ended.sessionId,
                resumePrompt: "Continue with the child's result.",
              },
              afterRetention,
            )
            .pipe(Effect.flip)
          if (!(error instanceof AgentWaitCustodyError)) throw error
          const custody = error
          expect(custody.reason).toBe("worktree_removed_after_retention")
          expect(custody.observed).toBe(ended.runId)
          expect(custody.mailboxId).toBe(ended.mailboxId)
          expect(custody.explanation).toContain("removed after the worktree retention period")
          expect(custody.explanation).toContain(ended.mailboxId)
          expect(custody.explanation).toContain("list_agent_runs")
        }).pipe(Effect.provide(layer(() => afterRetention))),
      )
    }))

  test("bounds the work of one iteration to its batch size", () =>
    withRepository(async ({ layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const runs = [
            yield* dispatch("first of a backlog"),
            yield* dispatch("second of a backlog"),
            yield* dispatch("third of a backlog"),
          ]
          for (const run of runs)
            yield* (yield* AgentRunStore).complete({ runId: run.runId, now: at })
          const janitor = yield* AgentRunWorktreeJanitor

          expect(yield* janitor.iteration).toBe("worked")
          const present = async () =>
            (await Promise.all(runs.map((run) => exists(run.directory)))).filter(Boolean).length
          expect(yield* Effect.promise(present)).toBe(1)

          expect(yield* janitor.iteration).toBe("worked")
          expect(yield* Effect.promise(present)).toBe(0)
          expect(yield* janitor.iteration).toBe("idle")
        }).pipe(Effect.provide(layer(() => afterRetention, undefined, 2))),
      )
    }))

  test("deletes ignored files with the worktree", () =>
    withRepository(async ({ repository, layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("left build output")
          yield* (yield* AgentRunStore).complete({ runId: run.runId, now: at })
          yield* Effect.promise(async () => {
            await writeFile(join(run.directory, ".gitignore"), "target/\n")
            await git(run.directory, "add", ".gitignore")
            await git(
              run.directory,
              "-c",
              "user.email=t@example.invalid",
              "-c",
              "user.name=T",
              "commit",
              "-m",
              "ignore target",
            )
            await mkdir(join(run.directory, "target"))
            await writeFile(join(run.directory, "target", "build.out"), "artifact\n")
          })

          yield* drain

          expect(yield* Effect.promise(() => exists(run.directory))).toBe(false)
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "removed", detail: null })
          expect(
            yield* Effect.promise(() => git(repository, "branch", "--list", run.branch)),
          ).toContain(run.branch)
        }).pipe(Effect.provide(layer(() => afterRetention))),
      )
    }))

  test("lists a run once when another host holds a resource at the same path", () =>
    withRepository(async ({ layer }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const run = yield* dispatch("shared path")
          yield* (yield* KernelSessionStore).registerResource({
            resourceId: "other-host-worktree",
            owningHostId: "other-host",
            absolutePath: run.directory,
            kind: "worktree",
            createdAt: at,
          })
          const runs = yield* (yield* McpQueries).listAgentRuns({ limit: 100 })
          expect(runs.filter((candidate) => candidate.run_id === run.runId)).toHaveLength(1)
          expect(yield* worktreeOf(run.runId)).toEqual({ worktree: "present", detail: null })
        }).pipe(Effect.provide(layer(() => at))),
      )
    }))
})

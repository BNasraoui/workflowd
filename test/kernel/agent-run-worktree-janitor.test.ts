import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Logger } from "effect"
import { agentRunIdentifiers, type AgentRunProviderPort } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import {
  AgentRunWorktreeJanitor,
  AgentRunWorktreeJanitorLive,
} from "../../src/kernel/agent-run-worktree-janitor"
import { gitAgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
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
) =>
  Layer.merge(
    AgentRunWorktreeJanitorLive({
      owningHostId: "mint",
      worktreeRoot,
      repositories,
      retentionMs: RETENTION_MS,
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
    readonly layer: (now: () => Date, filename?: string) => ReturnType<typeof testLayer>
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
    const layer = (now: () => Date, filename?: string) =>
      testLayer(repositories, join(root, "worktrees"), now, filename)
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
    return { runId: receipt.runId, directory: run!.directory, branch: `agent-run/${short}` }
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
            cleanupId: "main-checkout-cleanup",
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
})

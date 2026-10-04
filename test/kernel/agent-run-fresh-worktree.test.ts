import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { agentRunIdentifiers } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { gitAgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import {
  defaultState,
  makeLayer,
  makeProvider,
  refusalOf,
  register,
} from "./agent-run-ingress-harness"

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

const withFixture = async <A>(
  run: (
    context: Awaited<ReturnType<typeof fixture>> & {
      root: string
      provider: ReturnType<typeof defaultState>
      layer: ReturnType<typeof makeLayer>
    },
  ) => Promise<A>,
) => {
  const root = await mkdtemp(join(tmpdir(), "agent-run-ingress-git-"))
  try {
    const gitFixture = await fixture(root)
    const provider = defaultState()
    const layer = makeLayer(makeProvider(provider), gitAgentRunWorktrees, undefined, {
      repositories: [{ name: "fixture", directory: gitFixture.repository }],
      worktreeRoot: join(root, "worktrees"),
    })
    return await run({ root, ...gitFixture, provider, layer })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("agent-run fresh worktree", () => {
  test("real ingress uses the fetched origin default without changing the clone branch", () =>
    withFixture(async ({ repository, oldHead, newHead, provider, layer }) => {
      expect(await git(repository, "rev-parse", "origin/main")).toBe(oldHead)
      await Effect.runPromise(
        register({ route: "implement", repository: "fixture", prompt: "test" }).pipe(
          Effect.provide(layer),
        ),
      )
      expect(await git(provider.created[0]!.directory, "rev-parse", "HEAD")).toBe(newHead)
      expect(await git(repository, "rev-parse", "origin/main")).toBe(newHead)
      expect(await git(repository, "rev-parse", "HEAD")).toBe(oldHead)
      expect(await git(repository, "branch", "--show-current")).toBe("stale")
    }))

  test("fetch failure refuses dispatch before creating a worktree", () =>
    withFixture(async ({ root, repository, oldHead, provider, layer }) => {
      await git(repository, "remote", "set-url", "origin", join(root, "missing-origin"))
      const result = await Effect.runPromise(
        register({ route: "implement", repository: "fixture", prompt: "test" }).pipe(
          Effect.provide(layer),
          Effect.result,
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({ reason: "repository_fetch_failed" })
        expect(result.failure).not.toHaveProperty("mailboxId")
      }
      expect(provider.created).toHaveLength(0)
      expect(await git(repository, "worktree", "list", "--porcelain")).not.toContain("agent-runs")
      expect(await git(repository, "rev-parse", "HEAD")).toBe(oldHead)
    }))

  test("the exact failed submission re-dispatches after a worktree failure", () =>
    withFixture(async ({ root, repository, provider, layer }) => {
      const input = {
        route: "implement",
        repository: "fixture",
        prompt: "retry the same submission",
        baseRef: "release",
      } as const
      const identifiers = agentRunIdentifiers({
        ...input,
        parentSessionId: null,
        resumePrompt: null,
      })
      const blocker = join(root, "blocking-worktree")
      await git(repository, "worktree", "add", "-b", `agent-run/${identifiers.short}`, blocker)
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AgentRunStore
          const first = yield* register(input).pipe(Effect.result)
          expect(first._tag).toBe("Failure")
          if (first._tag === "Failure")
            expect(first.failure).toMatchObject({ reason: "worktree_failed" })
          expect(yield* store.read(identifiers.runId)).toBeNull()
          yield* Effect.promise(() => git(repository, "worktree", "remove", blocker))
          const receipt = yield* register(input)
          expect(receipt.runId).toBe(identifiers.runId)
          expect(receipt.status).toBe("dispatched")
          expect(yield* store.read(identifiers.runId)).not.toBeNull()
        }).pipe(Effect.provide(layer)),
      )
      expect(await git(provider.created[0]!.directory, "rev-parse", "--is-inside-work-tree")).toBe(
        "true",
      )
      expect(provider.created).toHaveLength(1)
    }))

  test("worktree add failure refuses dispatch without spawning a session", () =>
    withFixture(async ({ root, repository, newHead, provider, layer }) => {
      const input = {
        route: "implement",
        repository: "fixture",
        prompt: "blocked worktree",
      } as const
      const short = agentRunIdentifiers({
        ...input,
        parentSessionId: null,
        resumePrompt: null,
      }).short
      const blocker = join(root, "blocking-worktree")
      await git(repository, "worktree", "add", "-b", `agent-run/${short}`, blocker)
      const refusal = await refusalOf(
        Effect.runPromise(register(input).pipe(Effect.provide(layer))),
      )
      expect(refusal.reason).toBe("worktree_failed")
      expect(provider.created).toHaveLength(0)
      expect(await git(repository, "rev-parse", "origin/main")).toBe(newHead)
    }))

  test("an explicit base uses that fetched origin branch", () =>
    withFixture(async ({ oldHead, provider, layer }) => {
      await Effect.runPromise(
        register({
          route: "implement",
          repository: "fixture",
          prompt: "test",
          baseRef: "release",
        }).pipe(Effect.provide(layer)),
      )
      expect(await git(provider.created[0]!.directory, "rev-parse", "HEAD")).toBe(oldHead)
    }))

  test("an unknown explicit base is a typed refusal and a corrected base can use the same prompt", () =>
    withFixture(async ({ oldHead, provider, layer }) => {
      const bad = await refusalOf(
        Effect.runPromise(
          register({
            route: "implement",
            repository: "fixture",
            prompt: "same prompt",
            baseRef: "misspelled",
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(bad.reason).toBe("invalid_base_ref")
      expect(bad.detail).toContain("origin/misspelled")
      expect(bad).not.toHaveProperty("mailboxId")
      expect(provider.created).toHaveLength(0)
      await Effect.runPromise(
        register({
          route: "implement",
          repository: "fixture",
          prompt: "same prompt",
          baseRef: "release",
        }).pipe(Effect.provide(layer)),
      )
      expect(await git(provider.created[0]!.directory, "rev-parse", "HEAD")).toBe(oldHead)
    }))

  test("parallel dispatch worktrees share a repository without fetch conflicts", () =>
    withFixture(async ({ root, repository, newHead }) => {
      const directories = Array.from({ length: 6 }, (_, index) => join(root, `worktree-${index}`))
      await Promise.all(
        directories.map((directory, index) =>
          Effect.runPromise(
            gitAgentRunWorktrees.create({ repository, directory, branch: `agent/run-${index}` }),
          ),
        ),
      )
      for (const directory of directories) {
        expect(await git(directory, "rev-parse", "HEAD")).toBe(newHead)
      }
    }))
})

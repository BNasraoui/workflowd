import { randomUUID } from "node:crypto"
import { ScopedKeyedLock } from "../workspace/locks"
import { normalizeError } from "../errors"
import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { runWorkspaceCommand } from "../workspace/command"
import { WorkspaceError } from "../workspace/errors"
import type { AgentGitConfig } from "./config"
import { guardedHook, identityGuard } from "./hooks"

const locks = new ScopedKeyedLock()
const writeAtomic = async (path: string, content: string, options: { mode: number }) => {
  const temporary = `${path}.${randomUUID()}`
  try {
    await writeFile(temporary, content, { ...options, flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Install after worktree creation, including on retries of existing worktrees. */
export const installAgentGitGuard = (directory: string, config: AgentGitConfig | undefined) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (config === undefined) return
      const git = (...args: string[]) =>
        runWorkspaceCommand("install agent git guard", ["git", "-C", directory, ...args])
      const gitDir = yield* git("rev-parse", "--absolute-git-dir")
      yield* locks.acquire(yield* git("rev-parse", "--path-format=absolute", "--git-common-dir"))
      const hooks = join(gitDir, "workflowd-hooks")
      const previous = yield* git("rev-parse", "--path-format=absolute", "--git-path", "hooks")
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(hooks, { recursive: true, mode: 0o700 })
          const previousFile = join(hooks, "previous")
          const original =
            previous === hooks ? await readFile(previousFile, "utf8") : resolve(directory, previous)
          await writeAtomic(previousFile, original, { mode: 0o600 })
          await writeAtomic(join(hooks, "blocked-emails"), config.blockedEmails.join("\n") + "\n", {
            mode: 0o600,
          })
          const guard = join(hooks, "identity-guard")
          await writeAtomic(guard, identityGuard, { mode: 0o700 })
          for (const hook of [
            "applypatch-msg",
            "pre-applypatch",
            "post-applypatch",
            "pre-commit",
            "pre-merge-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-commit",
            "pre-rebase",
            "post-checkout",
            "post-merge",
            "pre-push",
            "post-rewrite",
            "reference-transaction",
            "post-index-change",
            "push-to-checkout",
            "pre-auto-gc",
            "pre-receive",
            "update",
            "proc-receive",
            "post-receive",
            "post-update",
            "fsmonitor-watchman",
            "sendemail-validate",
            "p4-changelist",
            "p4-prepare-changelist",
            "p4-post-changelist",
            "p4-pre-submit",
          ])
            await writeAtomic(join(hooks, hook), guardedHook(guard, hook, original), {
              mode: 0o700,
            })
        },
        catch: (cause) =>
          new WorkspaceError({
            operation: "install agent git guard",
            cause: normalizeError(cause),
          }),
      })
      // Conditional includes scope the policy to this git directory without changing
      // extensions.worktreeConfig or the main checkout's core.bare/core.worktree.
      const policy = join(hooks, "config")
      yield* git("config", "--file", policy, "core.hooksPath", hooks)
      yield* git("config", "--local", `includeIf.gitdir:${gitDir}.path`, policy)
      const effective = yield* git("rev-parse", "--path-format=absolute", "--git-path", "hooks")
      if (effective !== hooks)
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "install agent git guard",
            cause: new Error("Agent git guard is overridden by higher-priority Git configuration"),
          }),
        )
    }),
  )

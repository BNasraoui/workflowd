import { Context, Effect } from "effect"
import { runWorkspaceCommand } from "../workspace/command"
import type { WorkspaceError } from "../workspace/errors"
import { pathExists } from "../workspace/filesystem"
import { ScopedKeyedLock } from "../workspace/locks"

const repositoryLocks = new ScopedKeyedLock()

export const agentRunWorktreeFailure = (error: WorkspaceError) =>
  error.operation === "resolve agent-run base"
    ? ("invalid_base_ref" as const)
    : error.operation === "fetch agent-run repository" ||
        error.operation === "detect agent-run default branch"
      ? ("repository_fetch_failed" as const)
      : ("worktree_failed" as const)

export type AgentRunWorktreesPort = {
  readonly create: (input: {
    readonly repository: string
    readonly directory: string
    readonly branch: string
    readonly base?: string
  }) => Effect.Effect<void, WorkspaceError>
}

export const AgentRunWorktrees = Context.Service<AgentRunWorktreesPort>(
  "workflowd/kernel/AgentRunWorktrees",
)

/**
 * Creates the run's git worktree inside the allow-listed repository. Hooks
 * are disabled the same way the managed PR workspace does it, and an
 * existing directory short-circuits so a crashed dispatch can be retried.
 */
export const gitAgentRunWorktrees: AgentRunWorktreesPort = {
  create: (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* repositoryLocks.acquire(input.repository)
        if (yield* pathExists(input.directory)) return
        yield* runWorkspaceCommand("fetch agent-run repository", [
          "git",
          "-C",
          input.repository,
          "fetch",
          "origin",
        ])
        if (input.base === undefined) {
          yield* runWorkspaceCommand("detect agent-run default branch", [
            "git",
            "-C",
            input.repository,
            "remote",
            "set-head",
            "origin",
            "-a",
          ])
        }
        const base =
          input.base ??
          (yield* runWorkspaceCommand("resolve agent-run default branch", [
            "git",
            "-C",
            input.repository,
            "symbolic-ref",
            "--short",
            "refs/remotes/origin/HEAD",
          ]))
        yield* runWorkspaceCommand("resolve agent-run base", [
          "git",
          "-C",
          input.repository,
          "rev-parse",
          "--verify",
          "--quiet",
          `${base}^{commit}`,
        ])
        yield* runWorkspaceCommand("create agent-run worktree", [
          "git",
          "-C",
          input.repository,
          "-c",
          "core.hooksPath=/dev/null",
          "worktree",
          "add",
          "-B",
          input.branch,
          input.directory,
          base,
        ])
      }),
    ),
}

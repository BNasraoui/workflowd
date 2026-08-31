import { Context, Effect } from "effect"
import { runWorkspaceCommand } from "../workspace/command"
import type { WorkspaceError } from "../workspace/errors"
import { pathExists } from "../workspace/filesystem"

export type AgentRunWorktreesPort = {
  readonly create: (input: {
    readonly repository: string
    readonly directory: string
    readonly branch: string
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
    Effect.gen(function* () {
      if (yield* pathExists(input.directory)) return
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
        "HEAD",
      ])
    }),
}

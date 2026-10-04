import { Context, Data, Effect } from "effect"
import { runWorkspaceCommand } from "../workspace/command"
import { WorkspaceError } from "../workspace/errors"
import { pathExists } from "../workspace/filesystem"
import { ScopedKeyedLock } from "../workspace/locks"

const repositoryLocks = new ScopedKeyedLock()

const remoteCommand = (operation: string, repository: string, args: string[]) =>
  runWorkspaceCommand(operation, ["git", "-C", repository, ...args], {
    env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(new WorkspaceError({ operation, cause: new Error(`${operation} timed out`) })),
    }),
  )

export const agentRunWorktreeFailure = (error: WorkspaceError) => {
  if (error.operation === "resolve agent-run base") return "invalid_base_ref" as const
  if (
    error.operation === "fetch agent-run repository" ||
    error.operation === "detect agent-run default branch" ||
    error.operation === "resolve agent-run default head"
  ) {
    return "repository_fetch_failed" as const
  }
  return "worktree_failed" as const
}

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

export class AgentRunWorktreeSetupError extends Data.TaggedError("AgentRunWorktreeSetupError")<{
  readonly cause: WorkspaceError
}> {}

export const createAgentRunWorktree = (
  worktrees: AgentRunWorktreesPort,
  input: Parameters<AgentRunWorktreesPort["create"]>[0],
) =>
  worktrees
    .create(input)
    .pipe(Effect.mapError((cause) => new AgentRunWorktreeSetupError({ cause })))

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
        yield* remoteCommand("fetch agent-run repository", input.repository, ["fetch", "origin"])
        if (input.base === undefined) {
          yield* remoteCommand("detect agent-run default branch", input.repository, [
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
        yield* runWorkspaceCommand(
          input.base === undefined ? "resolve agent-run default head" : "resolve agent-run base",
          ["git", "-C", input.repository, "rev-parse", "--verify", `${base}^{commit}`],
          { env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } },
        )
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

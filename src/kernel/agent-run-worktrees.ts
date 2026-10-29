import { randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { startAgentHost, readAgentHostOutput } from "../agent-host/client"
import { normalizeError } from "../errors"
import type { AgentGitConfig } from "../agent-git/config"
import { installAgentGitGuard } from "../agent-git/guard"
import { Context, Data, Effect } from "effect"
import { runWorkspaceCommand } from "../workspace/command"
import { WorkspaceError } from "../workspace/errors"
import { filesystemEffect, pathExists } from "../workspace/filesystem"
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
  if (error.operation === "wait for agent-run repository") return "repository_busy" as const
  if (error.operation === "resolve agent-run base") return "invalid_base_ref" as const
  if (
    error.operation === "fetch agent-run repository" ||
    error.operation === "detect agent-run default branch" ||
    error.operation === "resolve agent-run default branch" ||
    error.operation === "resolve agent-run default head"
  ) {
    return "repository_fetch_failed" as const
  }
  return "worktree_failed" as const
}

export type AgentRunWorktreesPort = {
  readonly create: (input: {
    readonly git?: AgentGitConfig | undefined
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
 * existing directory skips creation but refreshes the identity guard on retry.
 */
export const gitAgentRunWorktrees: AgentRunWorktreesPort = {
  create: (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* repositoryLocks.acquire(input.repository).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.fail(
                new WorkspaceError({
                  operation: "wait for agent-run repository",
                  cause: new Error("repository is busy preparing another agent run"),
                }),
              ),
          }),
        )
        if (yield* pathExists(input.directory)) {
          yield* installAgentGitGuard(input.directory, input.git)
          return
        }
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
        yield* installAgentGitGuard(input.directory, input.git)
      }),
    ),
}

/** Native agent clones are created by the agent UID; the controller never runs Git in them. */
export const agentRunWorktrees = (socket: string | undefined): AgentRunWorktreesPort =>
  socket === undefined
    ? gitAgentRunWorktrees
    : {
        create: (input) =>
          Effect.tryPromise({
            try: async (signal) => {
              const process = await startAgentHost(socket, {
                profile: "workspace",
                runId: `workspace-${randomUUID()}`,
                directory: input.directory,
                repository: input.repository,
                branch: input.branch,
                ...(input.base === undefined ? {} : { base: input.base }),
                prompt: "",
                model: null,
                timeoutMs: 60000,
              })
              await readAgentHostOutput(socket, process, 1024, signal)
            },
            catch: (cause) =>
              new WorkspaceError({
                operation: "create agent-run worktree",
                cause: normalizeError(cause),
              }),
          }),
      }

export type AgentRunWorktreeRemoval =
  | { readonly outcome: "removed" }
  | { readonly outcome: "missing" }
  | { readonly outcome: "retained"; readonly detail: string }

const retained = (detail: string): AgentRunWorktreeRemoval => ({ outcome: "retained", detail })

/** `git worktree list --porcelain` reports a locked entry with a `locked [reason]` line. */
const isLocked = (list: string, directories: ReadonlyArray<string>) =>
  list.split("\n\n").some((entry) => {
    const lines = entry.split("\n")
    const path = lines[0]?.startsWith("worktree ") ? lines[0].slice("worktree ".length) : null
    return (
      path !== null &&
      directories.includes(path) &&
      lines.some((line) => line === "locked" || line.startsWith("locked "))
    )
  })

/**
 * Removes a finished run's linked worktree without force, then prunes the
 * repository's worktree records. The directory must be a linked worktree of
 * `repository`, never its main checkout, and must not be or resolve through
 * a symbolic link; a locked worktree or one with uncommitted or untracked
 * changes is retained with the reason. Ignored files (build output such as
 * `target/`) are deleted with the worktree. The run's branch is left alone.
 */
export const removeAgentRunWorktree = (input: {
  readonly repository: string
  readonly directory: string
}) =>
  Effect.gen(function* () {
    const prune = remoteCommand("prune agent-run worktrees", input.repository, [
      "worktree",
      "prune",
    ])
    const entry = yield* Effect.promise(() =>
      lstat(input.directory).then(
        (stats) => (stats.isSymbolicLink() ? ("symlink" as const) : ("present" as const)),
        () => "missing" as const,
      ),
    )
    if (entry === "missing") {
      yield* prune
      return { outcome: "missing" } as const
    }
    // `git worktree remove` follows a symlink and removes its target, which
    // may be another run's worktree.
    if (entry === "symlink") return retained("directory is a symbolic link")
    const expected = join(
      yield* filesystemEffect("resolve agent-run worktree root", () =>
        realpath(dirname(input.directory)),
      ),
      basename(input.directory),
    )
    const repositoryCommonDir = yield* remoteCommand(
      "locate agent-run repository",
      input.repository,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    const located = yield* remoteCommand("locate agent-run worktree", input.directory, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--show-toplevel",
    ]).pipe(Effect.result)
    if (located._tag === "Failure") return retained("directory is not a Git worktree")
    const [gitDir, commonDir, topLevel] = located.success.split("\n")
    const directory = yield* filesystemEffect("resolve agent-run worktree", () =>
      realpath(input.directory),
    )
    if (directory !== expected) return retained("directory resolves outside the agent-run root")
    if (topLevel !== directory) return retained("directory is not the top of a Git worktree")
    if (gitDir === commonDir) return retained("directory is a main checkout, not a linked worktree")
    if (commonDir !== repositoryCommonDir)
      return retained("worktree belongs to a different repository")
    const worktrees = yield* remoteCommand("list agent-run worktrees", input.repository, [
      "worktree",
      "list",
      "--porcelain",
    ])
    if (isLocked(worktrees, [input.directory, directory])) return retained("worktree is locked")
    const status = yield* remoteCommand("inspect agent-run worktree", input.directory, [
      "--no-optional-locks",
      "status",
      "--porcelain",
    ])
    if (status !== "") {
      const paths = status.split("\n").length
      return retained(
        `worktree has ${paths} uncommitted or untracked path${paths === 1 ? "" : "s"}`,
      )
    }
    yield* remoteCommand("remove agent-run worktree", input.repository, [
      "worktree",
      "remove",
      input.directory,
    ])
    yield* prune
    return { outcome: "removed" } as const
  })

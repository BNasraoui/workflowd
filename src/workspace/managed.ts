import { mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import type { Work } from "../domain/work"
import { runWorkspaceCommand } from "./command"
import { WorkspaceError } from "./errors"
import { filesystemEffect, filesystemTransition, pathExists } from "./filesystem"
import type { GitWorkspaceConfig, ResolvedWorktree, WorkspaceRemoteUrl } from "./model"

function runGit(operation: string, directory: string, ...args: ReadonlyArray<string>) {
  return runWorkspaceCommand(operation, ["git", "-C", directory, ...args])
}

export class ManagedWorkspaceLifecycle {
  readonly #config: GitWorkspaceConfig
  readonly #remoteUrl: WorkspaceRemoteUrl

  constructor(config: GitWorkspaceConfig, remoteUrl: WorkspaceRemoteUrl) {
    this.#config = config
    this.#remoteUrl = remoteUrl
  }

  remove(repository: string, directory: string) {
    return Effect.gen(this, function* () {
      yield* runGit(
        "remove managed review worktree",
        repository,
        "worktree",
        "remove",
        "--force",
        directory,
      ).pipe(Effect.ignore)
      yield* filesystemTransition("remove managed worktree directory", () =>
        rm(directory, { recursive: true, force: true }),
      )
      yield* runGit(
        "prune managed worktrees",
        repository,
        "worktree",
        "prune",
        "--expire",
        "now",
      ).pipe(Effect.ignore)
    })
  }

  create(work: Work): Effect.Effect<ResolvedWorktree, WorkspaceError> {
    return Effect.gen(this, function* () {
      const parts = work.repositoryFullName.split("/")
      if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "validate repository name",
            cause: new Error(`Invalid repository name: ${work.repositoryFullName}`),
          }),
        )
      }
      const repository = join(this.#config.repositoryRoot, "github.com", parts[0]!, parts[1]!)
      const directory = join(
        this.#config.worktreeRoot,
        String(work.repositoryId),
        String(work.pullRequestNumber),
        `${work.id}-${work.generation}`,
      )
      const sameRepository =
        work.repositoryFullName.toLowerCase() === work.target.headRepositoryFullName.toLowerCase()

      yield* runWorkspaceCommand("validate head branch", [
        "git",
        "check-ref-format",
        "--branch",
        work.target.headRef,
      ])
      yield* runWorkspaceCommand("validate base branch", [
        "git",
        "check-ref-format",
        "--branch",
        work.target.baseRef,
      ])
      if (work._tag === "FixWork" && (yield* pathExists(directory))) {
        const validWorktree = yield* runGit(
          "inspect retained fix worktree",
          directory,
          "rev-parse",
          "--git-dir",
        ).pipe(Effect.option)
        if (validWorktree._tag === "Some") {
          return {
            directory,
            repository,
            managed: true,
            pull: sameRepository,
          } satisfies ResolvedWorktree
        }
      }
      yield* filesystemEffect("create repository directory", () =>
        mkdir(dirname(repository), { recursive: true }),
      )
      yield* filesystemEffect("create worktree directory", () =>
        mkdir(dirname(directory), { recursive: true }),
      )
      if (!(yield* pathExists(repository))) {
        yield* runWorkspaceCommand("clone repository", [
          "git",
          "clone",
          this.#remoteUrl(work.repositoryFullName),
          repository,
        ])
      }
      const pullRef = `refs/workflowd/pull/${work.pullRequestNumber}`
      const refspecs = [
        `+refs/pull/${work.pullRequestNumber}/head:${pullRef}`,
        `+refs/heads/${work.target.baseRef}:refs/remotes/origin/${work.target.baseRef}`,
        ...(sameRepository
          ? [`+refs/heads/${work.target.headRef}:refs/remotes/origin/${work.target.headRef}`]
          : []),
      ]
      yield* runGit(
        "fetch pull request",
        repository,
        "fetch",
        "--force",
        "--prune",
        "origin",
        ...refspecs,
      )
      yield* this.remove(repository, directory)
      const retainedFixCommit =
        work._tag === "FixWork"
          ? yield* runGit(
              "inspect retained fix commit",
              repository,
              "log",
              "-1",
              "--format=%B",
              `refs/heads/${work.target.headRef}`,
            ).pipe(Effect.option)
          : undefined
      const retainBranch =
        retainedFixCommit?._tag === "Some" &&
        retainedFixCommit.value.includes(`Workflowd-Job: ${work.id}`)
      yield* this.#installWorktree(
        work,
        repository,
        directory,
        pullRef,
        retainBranch,
        sameRepository,
      ).pipe(
        Effect.onError(() =>
          this.remove(repository, directory).pipe(
            Effect.catchAll((error) => Effect.logWarning(error)),
          ),
        ),
      )
      return {
        directory,
        repository,
        managed: true,
        pull: sameRepository,
      } satisfies ResolvedWorktree
    })
  }

  #installWorktree(
    work: Work,
    repository: string,
    directory: string,
    pullRef: string,
    retainBranch: boolean,
    sameRepository: boolean,
  ) {
    return Effect.gen(function* () {
      yield* runGit(
        "create managed review worktree",
        repository,
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        ...(!sameRepository
          ? ["--detach", directory, pullRef]
          : retainBranch
            ? [directory, work.target.headRef]
            : ["-B", work.target.headRef, directory, pullRef]),
      )
      if (!sameRepository) return
      yield* runGit(
        "set managed worktree upstream",
        directory,
        "branch",
        "--set-upstream-to",
        `origin/${work.target.headRef}`,
        work.target.headRef,
      )
    })
  }
}

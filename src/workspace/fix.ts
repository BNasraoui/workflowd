import { Effect } from "effect"
import type { FixResult } from "../domain/fix-result"
import type { FixWork } from "../domain/work"
import { runWorkspaceCommand } from "./command"
import { WorkspaceError } from "./errors"
import type { DurableJobCurrentness, FixWorkspace } from "./model"

function runGit(operation: string, directory: string, ...args: ReadonlyArray<string>) {
  return runWorkspaceCommand(operation, ["git", "-C", directory, ...args])
}

function worktreeStatus(directory: string) {
  return runGit(
    "verify fix worktree cleanliness",
    directory,
    "status",
    "--porcelain",
    "--untracked-files=all",
  )
}

function recover(work: FixWork, directory: string, head: string, gitSigningKey?: string) {
  return Effect.gen(function* () {
    if (head === work.target.headSha) return "none" as const
    yield* verifyCommit(work, directory, head, gitSigningKey)
    const remote = yield* remoteHead(work, directory)
    if (remote === head) return "pushed" as const
    if (remote === work.target.headSha) return "committed" as const
    return yield* Effect.fail(
      new WorkspaceError({
        operation: "recover fix publication",
        cause: new Error(`Remote branch is ${remote}, expected ${work.target.headSha} or ${head}`),
      }),
    )
  })
}

function publish(
  work: FixWork,
  workspace: FixWorkspace,
  result: FixResult | undefined,
  isCurrent: DurableJobCurrentness,
  gitSigningKey?: string,
) {
  return Effect.gen(function* () {
    const status = yield* worktreeStatus(workspace.directory)
    if (status !== "") {
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "verify fix worktree cleanliness",
          cause: new Error(`Fix worktree has uncommitted changes:\n${status}`),
        }),
      )
    }
    const head = yield* runGit(
      "resolve completed fix head",
      workspace.directory,
      "rev-parse",
      "HEAD",
    )
    const remote = yield* remoteHead(work, workspace.directory)

    if (result?._tag === "NoChanges") {
      if (head !== work.target.headSha || remote !== work.target.headSha) {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "verify no-change fix",
            cause: new Error(
              `Expected unchanged ${work.target.headSha}, found local ${head} and remote ${remote}`,
            ),
          }),
        )
      }
      return
    }

    yield* verifyCommit(work, workspace.directory, head, gitSigningKey)
    if (result?._tag === "CommitPrepared" && result.commitSha !== head) {
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "verify structured fix result",
          cause: new Error(`FixResult reported ${result.commitSha}, found ${head}`),
        }),
      )
    }
    if (remote === work.target.headSha) {
      const now = new Date(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      if (!(yield* isCurrent(now))) {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "verify fix currentness",
            cause: new Error(`Fix job ${work.id} is no longer current`),
          }),
        )
      }
      yield* runGit(
        "push verified fix commit",
        workspace.directory,
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "origin",
        `HEAD:refs/heads/${work.target.headRef}`,
      )
    } else if (remote !== head) {
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "verify remote fix branch",
          cause: new Error(
            `Remote branch is ${remote}, expected ${work.target.headSha} or ${head}`,
          ),
        }),
      )
    }
    const published = yield* remoteHead(work, workspace.directory)
    if (published !== head) {
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "verify pushed fix commit",
          cause: new Error(`Expected remote ${head}, found ${published}`),
        }),
      )
    }
  })
}

function remoteHead(work: FixWork, directory: string) {
  return Effect.gen(function* () {
    const output = yield* runGit(
      "resolve remote fix branch",
      directory,
      "ls-remote",
      "--refs",
      "origin",
      `refs/heads/${work.target.headRef}`,
    )
    const sha = output.split(/\s+/, 1)[0]
    if (sha) return sha
    return yield* Effect.fail(
      new WorkspaceError({
        operation: "resolve remote fix branch",
        cause: new Error(`Remote branch ${work.target.headRef} is unavailable`),
      }),
    )
  })
}

function verifyCommit(work: FixWork, directory: string, head: string, gitSigningKey?: string) {
  return Effect.gen(function* () {
    if (head === work.target.headSha) {
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "verify fix commit",
          cause: new Error("Fix did not create a commit"),
        }),
      )
    }
    const parents = yield* runGit(
      "verify fix ancestry",
      directory,
      "show",
      "-s",
      "--format=%P",
      head,
    )
    if (parents !== work.target.headSha) {
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "verify fix ancestry",
          cause: new Error(`Commit ${head} must have sole parent ${work.target.headSha}`),
        }),
      )
    }
    const message = yield* runGit(
      "verify fix commit ownership",
      directory,
      "log",
      "-1",
      "--format=%B",
      head,
    )
    const jobIds = [...message.matchAll(/^Workflowd-Job: ([1-9]\d*)$/gm)]
    if (jobIds.length !== 1 || Number(jobIds[0]?.[1]) !== work.id) {
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "verify fix commit ownership",
          cause: new Error(`Commit ${head} is not owned by fix job ${work.id}`),
        }),
      )
    }
    if (gitSigningKey !== undefined) {
      const signature = yield* runGit(
        "verify controller fix signature",
        directory,
        "log",
        "-1",
        "--format=%G?%x00%GF%x00%GP",
        head,
      )
      const [status, fingerprint, primaryFingerprint] = signature.split("\0")
      if (
        (status !== "G" && status !== "U") ||
        ![fingerprint, primaryFingerprint].some(
          (observed) => observed?.toLowerCase() === gitSigningKey.toLowerCase(),
        )
      ) {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "verify controller fix signature",
            cause: new Error(`Commit ${head} is not signed by the configured controller key`),
          }),
        )
      }
    }
  })
}

export function makeFixPublication(gitSigningKey?: string) {
  return {
    publish: (
      work: FixWork,
      workspace: FixWorkspace,
      result: FixResult | undefined,
      isCurrent: DurableJobCurrentness,
    ) => publish(work, workspace, result, isCurrent, gitSigningKey),
    recover: (work: FixWork, directory: string, head: string) =>
      recover(work, directory, head, gitSigningKey),
    worktreeStatus,
  }
}

export type FixPublication = ReturnType<typeof makeFixPublication>

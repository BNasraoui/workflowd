import { createHash } from "node:crypto"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Schema } from "effect"
import { runWorkspaceCommand } from "../workspace/command"
import { ScopedKeyedLock } from "../workspace/locks"
import { RepositoryReference } from "./domain"

const GitSha = Schema.String.pipe(Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))

export type QrspiWorkspaceInput = {
  readonly repository: typeof RepositoryReference.Type
  readonly workflowId: string
  readonly headRef: string
  readonly targetSha: string
}

export type QrspiWorkspacePort = {
  readonly withWorkspace: <A, E, R>(
    input: QrspiWorkspaceInput,
    use: (directory: string) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Error, R>
}

export const QrspiWorkspace = Context.GenericTag<QrspiWorkspacePort>("workflowd/qrspi/Workspace")

export class GitQrspiWorkspace implements QrspiWorkspacePort {
  readonly #workflowLocks = new ScopedKeyedLock()
  readonly #prepareLock = Effect.unsafeMakeSemaphore(1)

  constructor(
    private readonly repositoryDirectory: string,
    private readonly worktreeRoot: string,
  ) {}

  readonly withWorkspace: QrspiWorkspacePort["withWorkspace"] = (input, use) => {
    const decodedRepository = Schema.decodeUnknownSync(RepositoryReference)(input.repository)
    const targetSha = Schema.decodeUnknownSync(GitSha)(input.targetSha)
    const key = `${decodedRepository.repositoryId}:${input.workflowId}`
    return Effect.scoped(
      this.#workflowLocks
        .acquire(key)
        .pipe(
          Effect.zipRight(
            this.prepare({ ...input, repository: decodedRepository, targetSha }).pipe(
              Effect.flatMap(use),
            ),
          ),
        ),
    )
  }

  private prepare(input: QrspiWorkspaceInput) {
    const identity = createHash("sha256")
      .update(`${input.repository.repositoryId}\0${input.workflowId}`)
      .digest("hex")
    const directory = join(this.worktreeRoot, "qrspi", identity)
    return this.#prepareLock.withPermits(1)(
      Effect.gen(this, function* () {
        yield* Effect.tryPromise({
          try: () => mkdir(join(this.worktreeRoot, "qrspi"), { recursive: true }),
          catch: (cause) => new Error("Could not create QRSPI worktree root", { cause }),
        })
        yield* this.git("fetch durable ticket ref", [
          "fetch",
          "origin",
          `refs/heads/${input.headRef}`,
        ])
        yield* this.git("verify durable workflow target", [
          "cat-file",
          "-e",
          `${input.targetSha}^{commit}`,
        ])
        const present = yield* Effect.tryPromise({
          try: async () => {
            try {
              return (await stat(directory)).isDirectory()
            } catch (cause) {
              if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
                return false
              }
              throw cause
            }
          },
          catch: (cause) => new Error("Could not inspect QRSPI worktree", { cause }),
        })
        if (!present) {
          yield* this.git("prune stale QRSPI worktrees", ["worktree", "prune"])
          yield* this.git("create QRSPI worktree", [
            "worktree",
            "add",
            "--detach",
            directory,
            input.targetSha,
          ])
        } else {
          yield* this.gitAt(directory, "reset QRSPI worktree", ["reset", "--hard", input.targetSha])
          yield* this.gitAt(directory, "clean QRSPI worktree", ["clean", "-fdx"])
        }
        return directory
      }),
    )
  }

  private git(operation: string, args: ReadonlyArray<string>) {
    return this.gitAt(this.repositoryDirectory, operation, args)
  }

  private gitAt(directory: string, operation: string, args: ReadonlyArray<string>) {
    return runWorkspaceCommand(operation, ["git", ...args], { cwd: directory }).pipe(
      Effect.mapError((cause) => new Error(`${operation}: ${String(cause)}`, { cause })),
    )
  }
}

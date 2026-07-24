import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import type { FixWork, ReviewWork, Work } from "../domain/work"
import type { HeadEvidence } from "../domain/head-evidence"
import type { JsonSerializable } from "../json"
import { runWorkspaceCommand, runWorkspaceCommandBytes } from "./command"
import { WorkspaceError } from "./errors"
import { filesystemEffect, filesystemTransition, pathExists } from "./filesystem"
import type { FixWorkspace, ResolvedWorktree, ReviewWorkspace } from "./model"
import type { FixPublication } from "./fix"

const contextOwner = "workflowd:v1\n"
const contextMarker = ".managed-by-workflowd"
const truncatedDiffMarker = "\n\n[diff truncated by workflowd]\n"

function trimAsciiWhitespaceEnd(bytes: Uint8Array): Uint8Array {
  let length = bytes.byteLength
  while (length > 0) {
    const byte = bytes[length - 1]!
    if (![9, 10, 11, 12, 13, 32].includes(byte)) break
    length -= 1
  }
  return bytes.subarray(0, length)
}

function runGit(operation: string, directory: string, ...args: ReadonlyArray<string>) {
  return runWorkspaceCommand(operation, ["git", "-C", directory, ...args])
}

export class ReviewContextFiles {
  readonly #maxDiffBytes: number
  readonly #fixes: FixPublication
  readonly #gitSigningKey: string | undefined

  constructor(maxDiffBytes: number, fixes: FixPublication, gitSigningKey?: string) {
    this.#maxDiffBytes = maxDiffBytes
    this.#fixes = fixes
    this.#gitSigningKey = gitSigningKey
  }

  cleanup(directory: string) {
    return Effect.gen(function* () {
      const contextDirectory = join(directory, ".workflowd")
      const tracked = yield* runGit(
        "verify review context is untracked",
        directory,
        "ls-files",
        "--cached",
        "--",
        ".workflowd",
      )
      if (tracked !== "") {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "remove review context",
            cause: new Error(`Refusing to remove tracked context ${contextDirectory}`),
          }),
        )
      }
      if (!(yield* pathExists(contextDirectory))) return
      const owner = yield* filesystemEffect("read review context owner", (signal) =>
        readFile(join(contextDirectory, contextMarker), {
          encoding: "utf8",
          signal,
        }),
      ).pipe(Effect.option)
      if (owner._tag === "None" || owner.value !== contextOwner) {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "remove review context",
            cause: new Error(`Refusing to remove unowned context ${contextDirectory}`),
          }),
        )
      }
      yield* filesystemTransition("remove review context", () =>
        rm(contextDirectory, { recursive: true, force: true }),
      )
      const remaining = yield* runGit(
        "verify review context cleanup",
        directory,
        "status",
        "--porcelain",
        "--",
        ".workflowd",
      )
      if (remaining !== "") {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "verify review context cleanup",
            cause: new Error(`Review context remains staged or tracked in ${directory}`),
          }),
        )
      }
    })
  }

  installExclusion(directory: string) {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        yield* runGit(
          "enable worktree-specific Git config",
          directory,
          "config",
          "extensions.worktreeConfig",
          "true",
        )
        const previous = yield* runGit(
          "read review context exclusion",
          directory,
          "config",
          "--worktree",
          "--get",
          "core.excludesFile",
        ).pipe(Effect.option)
        const gitDirectory = yield* runGit(
          "resolve worktree Git directory",
          directory,
          "rev-parse",
          "--absolute-git-dir",
        )
        const exclusion = join(gitDirectory, `workflowd-exclude-${randomUUID()}`)
        yield* filesystemEffect("write review context exclusion", (signal) =>
          writeFile(exclusion, "/.workflowd/\n", { mode: 0o600, signal }),
        )
        yield* runGit(
          "install review context exclusion",
          directory,
          "config",
          "--worktree",
          "core.excludesFile",
          exclusion,
        )
        return { exclusion, previous }
      }),
      ({ exclusion, previous }) =>
        Effect.gen(function* () {
          const restore =
            previous._tag === "Some"
              ? ["config", "--worktree", "core.excludesFile", previous.value]
              : ["config", "--worktree", "--unset-all", "core.excludesFile"]
          const operation =
            previous._tag === "Some"
              ? "restore review context exclusion"
              : "remove review context exclusion"
          yield* runGit(operation, directory, ...restore).pipe(Effect.ignore)
          yield* filesystemTransition("remove review context exclusion", () =>
            rm(exclusion, { force: true }),
          ).pipe(Effect.ignore)
        }),
    )
  }

  prepareReview(work: ReviewWork, resolved: ResolvedWorktree, evidence?: HeadEvidence) {
    return Effect.gen(this, function* () {
      yield* this.#cleanupExisting(resolved.directory)
      yield* this.#requireClean(resolved.directory, "check worktree status")
      if (resolved.pull) {
        yield* this.#pull(resolved.directory)
        yield* this.#requireClean(resolved.directory, "check worktree status after pull")
      }
      const head = yield* this.#head(resolved.directory)
      if (head !== work.target.headSha) {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "verify pull request head",
            cause: new Error(`Expected ${work.target.headSha}, found ${head}`),
          }),
        )
      }
      yield* this.#write(work, resolved.directory, evidence)
      return {
        directory: resolved.directory,
        ...(resolved.managed ? { directoryCleanupScheduled: true as const } : {}),
      } satisfies ReviewWorkspace
    })
  }

  prepareFix(work: FixWork, resolved: ResolvedWorktree, evidence?: HeadEvidence) {
    return Effect.gen(this, function* () {
      yield* this.#cleanupExisting(resolved.directory)
      if (this.#gitSigningKey !== undefined) {
        yield* this.#configureSigning(resolved.directory, this.#gitSigningKey)
      }
      const initialStatus = yield* this.#fixes.worktreeStatus(resolved.directory)
      if (resolved.pull && initialStatus === "") yield* this.#pull(resolved.directory)
      const head = yield* this.#head(resolved.directory)
      if (initialStatus !== "" && head !== work.target.headSha) {
        return yield* Effect.fail(
          new WorkspaceError({
            operation: "recover dirty fix worktree",
            cause: new Error(`Dirty worktree moved from ${work.target.headSha} to ${head}`),
          }),
        )
      }
      const recovery = yield* this.#fixes.recover(work, resolved.directory, head)
      yield* this.#write(work, resolved.directory, evidence)
      return { directory: resolved.directory, recovery } satisfies Omit<
        FixWorkspace,
        "markCompleted"
      >
    })
  }

  #configureSigning(directory: string, signingKey: string) {
    const settings = [
      ["gpg.format", "openpgp"],
      ["user.signingKey", signingKey],
      ["commit.gpgSign", "true"],
    ] as const
    return Effect.gen(function* () {
      const previous = yield* Effect.forEach(settings, ([name]) =>
        runGit(
          "read fixer signing configuration",
          directory,
          "config",
          "--worktree",
          "--get",
          name,
        ).pipe(Effect.option),
      )
      yield* Effect.addFinalizer(() =>
        Effect.forEach(settings, ([name], index) => {
          const value = previous[index]!
          const args =
            value._tag === "Some"
              ? ["config", "--worktree", name, value.value]
              : ["config", "--worktree", "--unset-all", name]
          return runGit("restore fixer signing configuration", directory, ...args).pipe(
            Effect.ignore,
          )
        }).pipe(Effect.asVoid),
      )
      yield* Effect.forEach(settings, ([name, value]) =>
        runGit(
          "configure controller commit signing",
          directory,
          "config",
          "--worktree",
          name,
          value,
        ),
      )
    })
  }

  #cleanupExisting(directory: string) {
    const contextDirectory = join(directory, ".workflowd")
    return pathExists(contextDirectory).pipe(
      Effect.flatMap((exists) => (exists ? this.cleanup(directory) : Effect.void)),
    )
  }

  #requireClean(directory: string, operation: string) {
    return runGit(operation, directory, "status", "--porcelain", "--untracked-files=all").pipe(
      Effect.flatMap((status) =>
        status === ""
          ? Effect.void
          : Effect.fail(
              new WorkspaceError({
                operation,
                cause: new Error(`Refusing to review dirty worktree ${directory}`),
              }),
            ),
      ),
    )
  }

  #pull(directory: string) {
    return runGit(
      "pull review worktree",
      directory,
      "-c",
      "core.hooksPath=/dev/null",
      "pull",
      "--ff-only",
    )
  }

  #head(directory: string) {
    return runGit("resolve review head", directory, "rev-parse", "HEAD")
  }

  #write(work: Work, directory: string, evidence?: HeadEvidence) {
    return Effect.gen(this, function* () {
      yield* runGit(
        "verify base commit",
        directory,
        "cat-file",
        "-e",
        `${work.target.baseSha}^{commit}`,
      )
      const contextDirectory = join(directory, ".workflowd")
      const temporaryContext = join(directory, `.workflowd-${randomUUID()}`)
      yield* this.#populate(work, evidence, directory, temporaryContext, contextDirectory).pipe(
        Effect.ensuring(
          filesystemTransition("remove temporary review context", () =>
            rm(temporaryContext, { recursive: true, force: true }),
          ).pipe(Effect.ignore),
        ),
      )
    })
  }

  #populate(
    work: Work,
    evidence: HeadEvidence | undefined,
    directory: string,
    temporaryContext: string,
    contextDirectory: string,
  ) {
    return Effect.gen(this, function* () {
      yield* filesystemEffect("create review context directory", () => mkdir(temporaryContext))
      yield* filesystemEffect("write review context owner", (signal) =>
        writeFile(join(temporaryContext, contextMarker), contextOwner, {
          mode: 0o600,
          signal,
        }),
      )
      const rawDiff = yield* runWorkspaceCommandBytes(
        "generate pull request diff",
        [
          "git",
          "-c",
          "core.hooksPath=/dev/null",
          "diff",
          "--no-ext-diff",
          "--unified=80",
          `${work.target.baseSha}...${work.target.headSha}`,
          "--",
        ],
        { cwd: directory, maxStdoutBytes: this.#maxDiffBytes },
      )
      const diffPath = join(temporaryContext, "review.diff")
      const retainedDiff = rawDiff.truncated
        ? rawDiff.stdout
        : trimAsciiWhitespaceEnd(rawDiff.stdout)
      yield* filesystemEffect("write review diff", (signal) =>
        writeFile(diffPath, retainedDiff, { mode: 0o600, signal }),
      )
      if (rawDiff.truncated) {
        yield* filesystemEffect("write review diff truncation marker", (signal) =>
          writeFile(diffPath, truncatedDiffMarker, { flag: "a", signal }),
        )
      }
      yield* this.#writeJson("write review metadata", temporaryContext, "metadata.json", {
        repository: work.repositoryFullName,
        pullRequest: work.pullRequestNumber,
        baseSha: work.target.baseSha,
        headSha: work.target.headSha,
        generation: work.generation,
      })
      if (evidence !== undefined) {
        yield* this.#writeJson(
          "write exact-head evidence",
          temporaryContext,
          "evidence.json",
          evidence,
        )
      }
      if (work._tag === "FixWork") {
        yield* this.#writeJson(
          "write review findings",
          temporaryContext,
          "review.json",
          work.review,
        )
      }
      yield* filesystemTransition("publish review context", () =>
        rename(temporaryContext, contextDirectory),
      )
    })
  }

  #writeJson(operation: string, directory: string, filename: string, value: JsonSerializable) {
    return filesystemEffect(operation, (signal) =>
      writeFile(join(directory, filename), `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        signal,
      }),
    )
  }
}

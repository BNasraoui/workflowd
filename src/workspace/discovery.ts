import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { Work } from "../domain/work"
import { normalizeError } from "../errors"
import { runWorkspaceCommand } from "./command"
import { WorkspaceError } from "./errors"
import { pathExists } from "./filesystem"
import type {
  GitWorkspaceConfig,
  ResolvedWorktree,
  WorkspaceRemoteUrl,
} from "./model"

type RootVersion = number | string | null

type LocalRepositoryCatalogIo = {
  readonly now: () => number
  readonly modifiedAt: (root: string) => Promise<RootVersion>
  readonly readSubdirectories: (root: string) => Promise<ReadonlyArray<string>>
}

type RootSnapshot = {
  readonly version: RootVersion
  readonly candidates: ReadonlyArray<string>
}

const WorktreeRegistryRecord = Schema.Struct({
  state: Schema.optional(Schema.String),
  github_repository: Schema.String,
  branch: Schema.String,
  worktree: Schema.String,
})

const WorktreeRegistryRecordJson = Schema.parseJson(WorktreeRegistryRecord)

const defaultCatalogIo: LocalRepositoryCatalogIo = {
  now: Date.now,
  modifiedAt: (root) =>
    stat(root, { bigint: true }).then(
      (value) => `${value.mtimeNs}:${value.ctimeNs}:${value.size}`,
      () => null,
    ),
  readSubdirectories: (root) =>
    readdir(root, { withFileTypes: true }).then(
      (entries) =>
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      () => [],
    ),
}

export class LocalRepositoryCatalog {
  readonly #roots: ReadonlyArray<string>
  readonly #ttlMs: number
  readonly #io: LocalRepositoryCatalogIo
  readonly #snapshots = new Map<string, RootSnapshot>()
  #expiresAt = Number.NEGATIVE_INFINITY
  #refreshing: Promise<ReadonlyArray<string>> | undefined

  constructor(
    roots: ReadonlyArray<string>,
    options: {
      readonly ttlMs: number
      readonly io?: LocalRepositoryCatalogIo
    },
  ) {
    this.#roots = roots
    this.#ttlMs = options.ttlMs
    this.#io = options.io ?? defaultCatalogIo
  }

  candidates(): Promise<ReadonlyArray<string>> {
    return this.#snapshots.size === this.#roots.length &&
      this.#io.now() < this.#expiresAt
      ? Promise.resolve(this.#allCandidates())
      : this.refreshChanged()
  }

  refreshChanged(): Promise<ReadonlyArray<string>> {
    if (this.#refreshing !== undefined) return this.#refreshing
    this.#refreshing = Promise.all(
      this.#roots.map(async (root) => {
        const version = await this.#io.modifiedAt(root)
        const previous = this.#snapshots.get(root)
        if (previous !== undefined && previous.version === version) return
        const entries = await this.#io.readSubdirectories(root)
        this.#snapshots.set(root, {
          version,
          candidates: [root, ...entries.map((entry) => join(root, entry))],
        })
      }),
    )
      .then(() => {
        this.#expiresAt = this.#io.now() + this.#ttlMs
        return this.#allCandidates()
      })
      .finally(() => {
        this.#refreshing = undefined
      })
    return this.#refreshing
  }

  #allCandidates(): ReadonlyArray<string> {
    return [
      ...new Set(
        this.#roots.flatMap(
          (root) => this.#snapshots.get(root)?.candidates ?? [root],
        ),
      ),
    ]
  }
}

function parseWorktrees(output: string) {
  return output
    .split("\n\n")
    .map((block) => {
      const fields = new Map(
        block
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf(" ")
            return separator === -1
              ? ([line, ""] as const)
              : ([line.slice(0, separator), line.slice(separator + 1)] as const)
          }),
      )
      return { directory: fields.get("worktree"), branch: fields.get("branch") }
    })
    .filter(
      (entry): entry is { readonly directory: string; readonly branch: string } =>
        entry.directory !== undefined && entry.branch !== undefined,
    )
}

function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .toLowerCase()
}

function runGit(operation: string, directory: string, ...args: ReadonlyArray<string>) {
  return runWorkspaceCommand(operation, ["git", "-C", directory, ...args])
}

export class ExistingWorktreeDiscovery {
  readonly #config: GitWorkspaceConfig
  readonly #remoteUrl: WorkspaceRemoteUrl
  readonly #localCatalog: LocalRepositoryCatalog

  constructor(
    config: GitWorkspaceConfig,
    remoteUrl: WorkspaceRemoteUrl,
    localCatalog: LocalRepositoryCatalog,
  ) {
    this.#config = config
    this.#remoteUrl = remoteUrl
    this.#localCatalog = localCatalog
  }

  discover(
    work: Work,
  ): Effect.Effect<ResolvedWorktree | null, WorkspaceError> {
    return Effect.gen(this, function* () {
      const expectedRemote = normalizeRemote(
        this.#remoteUrl(work.repositoryFullName),
      )
      const registered = yield* this.#registryCandidates(work)
      const registeredMatch = yield* this.#inspect(
        work,
        expectedRemote,
        registered,
      )
      if (registeredMatch !== null) return registeredMatch

      const discovered = yield* this.#readCatalog(() =>
        this.#localCatalog.candidates(),
      )
      const existing = yield* this.#inspect(work, expectedRemote, discovered)
      if (existing !== null) return existing

      // A cache miss revalidates root metadata so newly-created repositories are
      // visible immediately without rescanning unchanged roots on every job.
      const refreshed = yield* this.#readCatalog(() =>
        this.#localCatalog.refreshChanged(),
      )
      return yield* this.#inspect(work, expectedRemote, refreshed)
    })
  }

  #registryCandidates(work: Work) {
    const registry = this.#config.worktreeRegistry
    return Effect.gen(function* () {
      if (registry === undefined || !(yield* pathExists(registry))) return []
      const records = yield* runWorkspaceCommand("read worktree registry", [
        "flock",
        "--shared",
        join(registry, ".cleanup.lock"),
        "bash",
        "-c",
        'shopt -s nullglob; for file in "$1"/*.json; do cat -- "$file"; printf "\\0"; done',
        "_",
        registry,
      ])
      const matches: Array<string> = []
      for (const record of records.split("\0")) {
        if (record.trim() === "") continue
        const decoded = Schema.decodeUnknownOption(WorktreeRegistryRecordJson)(record)
        if (decoded._tag === "None") continue
        const value = decoded.value
        if (
          (value.state === undefined || value.state === "ready") &&
          value.github_repository.toLowerCase() ===
            work.repositoryFullName.toLowerCase() &&
          value.branch === work.target.headRef &&
          value.worktree !== ""
        ) {
          matches.push(value.worktree)
        }
      }
      return matches
    })
  }

  #inspect(
    work: Work,
    expectedRemote: string,
    repositories: ReadonlyArray<string>,
  ) {
    return Effect.gen(function* () {
      for (const repository of new Set(repositories)) {
        if (!(yield* pathExists(repository))) continue
        const origin = yield* runGit(
          "read repository remote",
          repository,
          "remote",
          "get-url",
          "origin",
        ).pipe(Effect.option)
        if (
          origin._tag === "None" ||
          normalizeRemote(origin.value) !== expectedRemote
        ) {
          continue
        }
        const listed = yield* runGit(
          "list repository worktrees",
          repository,
          "worktree",
          "list",
          "--porcelain",
        )
        const match = parseWorktrees(listed).find(
          (worktree) => worktree.branch === `refs/heads/${work.target.headRef}`,
        )
        if (match !== undefined) {
          return {
            directory: match.directory,
            repository,
            managed: false,
            pull: true,
          } satisfies ResolvedWorktree
        }
      }
      return null
    })
  }

  #readCatalog(read: () => Promise<ReadonlyArray<string>>) {
    return Effect.tryPromise({
      try: read,
      catch: (cause) =>
        new WorkspaceError({
          operation: "discover local repositories",
          cause: normalizeError(cause),
        }),
    })
  }
}

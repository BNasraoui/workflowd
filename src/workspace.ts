import { Context, Effect, Ref, type Scope } from "effect"
import type { FixResult } from "./domain/fix-result"
import type { HeadEvidence } from "./domain/head-evidence"
import type { FixWork, ReviewWork, Work } from "./domain/work"
import { ReviewContextFiles } from "./workspace/context"
import { ExistingWorktreeDiscovery, LocalRepositoryCatalog } from "./workspace/discovery"
import { ManagedWorkspaceLifecycle } from "./workspace/managed"
import { ScopedKeyedLock } from "./workspace/locks"
import { makeFixPublication } from "./workspace/fix"
import type {
  GitWorkspaceConfig,
  WorkspacePort,
  FixWorkspace,
  DurableJobCurrentness,
  ResolvedWorktree,
} from "./workspace/model"
import type { WorkspaceError } from "./workspace/errors"

export type {
  GitWorkspaceConfig,
  WorkspacePort,
  FixWorkspace,
  DurableJobCurrentness,
} from "./workspace/model"

export const Workspace = Context.GenericTag<WorkspacePort>("workflowd/Workspace")

export class GitWorkspaceAdapter implements WorkspacePort {
  readonly #catalog
  readonly #discovery
  readonly #managed
  readonly #context
  readonly #fixes
  readonly #repositoryLocks = new ScopedKeyedLock()
  readonly #worktreeLocks = new ScopedKeyedLock()

  constructor(config: GitWorkspaceConfig) {
    const remoteUrl =
      config.remoteUrl ??
      ((repositoryFullName: string) => `https://github.com/${repositoryFullName}.git`)
    this.#catalog = new LocalRepositoryCatalog(config.localRepositories, {
      ttlMs: 1_000,
    })
    this.#discovery = new ExistingWorktreeDiscovery(config, remoteUrl, this.#catalog)
    this.#managed = new ManagedWorkspaceLifecycle(config, remoteUrl)
    this.#fixes = makeFixPublication(config.gitSigningKey)
    this.#context = new ReviewContextFiles(config.maxDiffBytes, this.#fixes, config.gitSigningKey)
  }

  prepareReview(work: ReviewWork, evidence?: HeadEvidence) {
    return Effect.gen(this, function* () {
      const resolved = yield* this.#resolve(work, (workspace) => this.#removeManaged(workspace))
      yield* this.#acquireContext(resolved)
      return yield* this.#context.prepareReview(work, resolved, evidence)
    })
  }

  prepareFix(work: FixWork, evidence?: HeadEvidence) {
    return Effect.gen(this, function* () {
      const completed = yield* Ref.make(false)
      const resolved = yield* this.#resolve(work, (workspace) =>
        Ref.get(completed).pipe(
          Effect.flatMap((done) => (done ? this.#removeManaged(workspace) : Effect.void)),
        ),
      )
      yield* this.#acquireContext(resolved)
      const workspace = yield* this.#context.prepareFix(work, resolved, evidence)
      return {
        ...workspace,
        markCompleted: () => Effect.runSync(Ref.set(completed, true)),
      } satisfies FixWorkspace
    })
  }

  publishFix(
    work: FixWork,
    workspace: FixWorkspace,
    result: FixResult | undefined,
    isCurrent: DurableJobCurrentness,
  ) {
    return this.#fixes.publish(work, workspace, result, isCurrent)
  }

  #resolve(
    work: Work,
    release: (workspace: ResolvedWorktree) => Effect.Effect<void>,
  ): Effect.Effect<ResolvedWorktree, WorkspaceError, Scope.Scope> {
    return Effect.gen(this, function* () {
      const existing = yield* this.#discovery.discover(work)
      if (existing !== null) return existing
      yield* this.#repositoryLocks.acquire(work.repositoryFullName.toLowerCase())
      return yield* Effect.acquireRelease(this.#managed.create(work), release)
    })
  }

  #acquireContext(resolved: ResolvedWorktree) {
    return Effect.gen(this, function* () {
      yield* this.#worktreeLocks.acquire(resolved.directory)
      yield* this.#context.installExclusion(resolved.directory)
      yield* Effect.addFinalizer(() =>
        this.#context
          .cleanup(resolved.directory)
          .pipe(Effect.catchAll((error) => Effect.logWarning(error))),
      )
    })
  }

  #removeManaged(workspace: ResolvedWorktree) {
    return this.#managed
      .remove(workspace.repository, workspace.directory)
      .pipe(Effect.catchAll((error) => Effect.logWarning(error)))
  }
}

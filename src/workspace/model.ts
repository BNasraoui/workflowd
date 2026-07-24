import type { Effect, Scope } from "effect"
import type { FixResult } from "../domain/fix-result"
import type { FixWork, ReviewWork } from "../domain/work"
import type { WorkspaceError } from "./errors"

export type ReviewWorkspace = {
  readonly directory: string
  readonly directoryCleanupScheduled?: true
}

export type FixWorkspace = ReviewWorkspace & {
  readonly recovery: "none" | "committed" | "pushed"
  readonly markCompleted: () => void
}

export type DurableJobCurrentness = (now: Date) => Effect.Effect<boolean, WorkspaceError>

export type GitWorkspaceConfig = {
  readonly localRepositories: ReadonlyArray<string>
  readonly worktreeRegistry?: string
  readonly repositoryRoot: string
  readonly worktreeRoot: string
  readonly remoteUrl?: (repositoryFullName: string) => string
  readonly maxDiffBytes: number
  readonly gitSigningKey?: string
}

export type WorkspacePort = {
  readonly prepareReview: (
    work: ReviewWork,
  ) => Effect.Effect<ReviewWorkspace, WorkspaceError, Scope.Scope>
  readonly prepareFix: (work: FixWork) => Effect.Effect<FixWorkspace, WorkspaceError, Scope.Scope>
  readonly publishFix: (
    work: FixWork,
    workspace: FixWorkspace,
    result: FixResult | undefined,
    isCurrent: DurableJobCurrentness,
  ) => Effect.Effect<string | null, WorkspaceError>
}

export type ResolvedWorktree = {
  readonly directory: string
  readonly repository: string
  readonly managed: boolean
  readonly pull: boolean
}

export type WorkspaceRemoteUrl = (repositoryFullName: string) => string

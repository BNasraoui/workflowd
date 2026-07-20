import { Cause, Data, Effect, Exit } from "effect"
import type { FixWork, ReviewWork } from "./domain/work"
import { decideFixEligibility } from "./domain/transaction-policy"
import { GitHub } from "./github"
import { Automation } from "./opencode"
import { WorkflowStore } from "./store/contracts"
import { Workspace } from "./workspace"
import { WorkspaceError } from "./workspace/errors"

class JobCancelled extends Data.TaggedError("JobCancelled")<{}> {}

function interruptOnCancellation<A, E, R, CancellationError, CancellationRequirements>(
  operation: Effect.Effect<A, E, R>,
  pollIntervalMs: number,
  shouldCancel: () => Effect.Effect<
    boolean,
    CancellationError,
    CancellationRequirements
  >,
): Effect.Effect<
  A,
  E | JobCancelled | CancellationError,
  R | CancellationRequirements
> {
  const waitForCancellation: Effect.Effect<
    never,
    JobCancelled | CancellationError,
    CancellationRequirements
  > = Effect.suspend(() =>
    shouldCancel().pipe(
      Effect.flatMap((cancel) =>
        cancel
          ? Effect.fail(new JobCancelled())
          : Effect.sleep(pollIntervalMs).pipe(
              Effect.andThen(waitForCancellation),
            ),
      ),
    ),
  )
  return Effect.raceFirst(operation, waitForCancellation)
}

function leaseFailure<E>(cause: Cause.Cause<E>, attempt: number, now: () => Date) {
  const failedAt = now()
  const delay = Math.min(
    30_000 * 2 ** Math.max(0, attempt - 1),
    15 * 60_000,
  )
  return {
    failedAt,
    runAt: new Date(failedAt.getTime() + delay),
    error: Cause.pretty(cause),
  }
}

function processReviewWork(
  work: ReviewWork,
  workerId: string,
  agentBranchPrefixes: ReadonlyArray<string>,
  fixWorkEnabled: boolean,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const automation = yield* Automation
      const workspaces = yield* Workspace
      const workspace = yield* workspaces.prepareReview(work)
      const review = yield* automation.runReview({
        directory: workspace.directory,
        repositoryFullName: work.repositoryFullName,
        pullRequestNumber: work.pullRequestNumber,
        baseSha: work.target.baseSha,
        headSha: work.target.headSha,
      })
      const completedAt = new Date(
        yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      )
      return yield* store.completeReviewJob({
        jobId: work.id,
        workerId,
        completedAt,
        review,
        autoFix:
          fixWorkEnabled && decideFixEligibility({
            agentBranchPrefixes,
            headRef: work.target.headRef,
            repositoryFullName: work.repositoryFullName,
            headRepositoryFullName: work.target.headRepositoryFullName,
            review,
          })._tag === "Eligible",
      })
    }),
  )
}

function processFixWork(work: FixWork, workerId: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const automation = yield* Automation
      const workspaces = yield* Workspace
      const workspace = yield* workspaces.prepareFix(work)
      let result = work.checkpoint
      if (workspace.recovery === "none" && result === undefined) {
        result = yield* automation.runFix({
          jobId: work.id,
          directory: workspace.directory,
          repositoryFullName: work.repositoryFullName,
          pullRequestNumber: work.pullRequestNumber,
          baseSha: work.target.baseSha,
          headSha: work.target.headSha,
        })
        const recordedAt = new Date(
          yield* Effect.clockWith((clock) => clock.currentTimeMillis),
        )
        const recorded = yield* store.recordFixResult({
          jobId: work.id,
          workerId,
          recordedAt,
          result,
        })
        if (recorded === "stale") return "stale" as const
      }
      yield* workspaces.publishFix(work, workspace, result, (now) =>
        store.isJobCurrent(work.id, workerId, now).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceError({
                operation: "check durable Fix Work currentness",
                cause,
              }),
          ),
        ),
      )
      const completedAt = new Date(
        yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      )
      const disposition = yield* store.completeFixJob({
        jobId: work.id,
        workerId,
        completedAt,
      })
      if (disposition === "completed") workspace.markCompleted()
      return disposition
    }),
  )
}

export function runJobIteration(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly maxAttempts: number
  readonly timeoutMs: number
  readonly cancellationPollIntervalMs: number
  readonly agentBranchPrefixes: ReadonlyArray<string>
  readonly fixWorkEnabled: boolean
  readonly now: () => Date
}) {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const work = yield* store.claimNextJob({
      workerId: options.workerId,
      now: options.now(),
      leaseDurationMs: options.leaseDurationMs,
    })
    if (work === null) return "idle" as const
    if (work._tag === "FixWork" && !options.fixWorkEnabled) {
      return yield* store.disableFixJob({
        jobId: work.id,
        workerId: options.workerId,
        disabledAt: options.now(),
      })
    }

    const operation =
      work._tag === "ReviewWork"
        ? processReviewWork(
            work,
            options.workerId,
            options.agentBranchPrefixes,
            options.fixWorkEnabled,
          )
        : processFixWork(work, options.workerId)
    const exit = yield* Effect.exit(
      interruptOnCancellation(
        operation,
        options.cancellationPollIntervalMs,
        () => store.shouldCancelJob(work.id, options.workerId, options.now()),
      ).pipe(
        Effect.timeoutFail({
          duration: options.timeoutMs,
          onTimeout: () => new Error(`Job ${work.id} timed out`),
        }),
      ),
    )
    if (Exit.isSuccess(exit)) return exit.value

    return yield* store.rescheduleJob({
      jobId: work.id,
      workerId: options.workerId,
      ...leaseFailure(exit.cause, work.attempt, options.now),
      maxAttempts: options.maxAttempts,
    })
  })
}

export function runPublicationIteration(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly maxAttempts: number
  readonly timeoutMs: number
  readonly now: () => Date
}) {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const github = yield* GitHub
    const publication = yield* store.claimNextPublication({
      workerId: options.workerId,
      now: options.now(),
      leaseDurationMs: options.leaseDurationMs,
    })
    if (publication === null) return "idle" as const

    const exit = yield* Effect.exit(
      github
        .publishReview(publication, (now) =>
          store.isPublicationCurrent(
            publication.id,
            options.workerId,
            now,
          ),
        )
        .pipe(
          Effect.timeoutFail({
            duration: options.timeoutMs,
            onTimeout: () =>
              new Error(`Publication ${publication.id} timed out`),
          }),
        ),
    )
    if (Exit.isSuccess(exit)) {
      return yield* store.completePublication({
        publicationId: publication.id,
        workerId: options.workerId,
        completedAt: options.now(),
        outcome: exit.value,
      })
    }

    return yield* store.reschedulePublication({
      publicationId: publication.id,
      workerId: options.workerId,
      ...leaseFailure(exit.cause, publication.attempt, options.now),
      maxAttempts: options.maxAttempts,
    })
  })
}

export function runCommandIteration(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly maxAttempts: number
  readonly commandUsers: ReadonlyArray<string>
  readonly fixWorkEnabled: boolean
  readonly now: () => Date
}) {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const command = yield* store.claimNextCommand({
      workerId: options.workerId,
      now: options.now(),
      leaseDurationMs: options.leaseDurationMs,
    })
    if (command === null) return "idle" as const

    const authorized = options.commandUsers.includes(
      command.commenter.toLowerCase(),
    )
    const exit = yield* Effect.exit(
      store
        .executeCommand({
          commandId: command.id,
          workerId: options.workerId,
          authorized,
          fixWorkEnabled: options.fixWorkEnabled,
          completedAt: options.now(),
        })
        .pipe(
          Effect.tap((disposition) =>
            Effect.logInfo(
              `Command ${command.command} from ${command.commenter}: ${disposition}`,
            ),
          ),
        ),
    )
    if (Exit.isSuccess(exit)) return "completed" as const

    return yield* store.rescheduleCommand({
      commandId: command.id,
      workerId: options.workerId,
      ...leaseFailure(exit.cause, command.attempts, options.now),
      maxAttempts: options.maxAttempts,
    })
  })
}

export function runReconciliationIteration(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly maxAttempts: number
  readonly now: () => Date
}) {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    const github = yield* GitHub
    const reconciliation = yield* store.claimNextReconciliation({
      workerId: options.workerId,
      now: options.now(),
      leaseDurationMs: options.leaseDurationMs,
    })
    if (reconciliation === null) return "idle" as const

    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        const snapshot = yield* github.fetchPullRequestSnapshot({
          installationId: reconciliation.installationId,
          repositoryFullName: reconciliation.repositoryFullName,
          pullRequestNumber: reconciliation.pullRequestNumber,
        })
        return yield* store.applyReconciliationSnapshot({
          reconciliationId: reconciliation.id,
          workerId: options.workerId,
          snapshot,
          completedAt: options.now(),
        })
      }),
    )
    if (Exit.isSuccess(exit)) return exit.value

    return yield* store.rescheduleReconciliation({
      reconciliationId: reconciliation.id,
      workerId: options.workerId,
      ...leaseFailure(exit.cause, reconciliation.attempts, options.now),
      maxAttempts: options.maxAttempts,
    })
  })
}

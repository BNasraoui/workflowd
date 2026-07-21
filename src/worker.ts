import { randomUUID } from "node:crypto"
import { Cause, Data, Effect, Exit, Option } from "effect"
import { AgentHarness, AgentHarnessError } from "./agent-harness"
import type { FixWork, ReviewWork } from "./domain/work"
import { decideFixEligibility } from "./domain/transaction-policy"
import { GitHub } from "./github"
import { Automation, OpenCodeAutomationError } from "./opencode"
import { WorkflowStore } from "./store/contracts"
import { Workspace } from "./workspace"
import { WorkspaceError } from "./workspace/errors"

class JobCancelled extends Data.TaggedError("JobCancelled")<Record<never, never>> {}

function interruptOnCancellation<A, E, R, CancellationError, CancellationRequirements>(
  operation: Effect.Effect<A, E, R>,
  pollIntervalMs: number,
  shouldCancel: () => Effect.Effect<boolean, CancellationError, CancellationRequirements>,
): Effect.Effect<A, E | JobCancelled | CancellationError, R | CancellationRequirements> {
  const waitForCancellation: Effect.Effect<
    never,
    JobCancelled | CancellationError,
    CancellationRequirements
  > = Effect.suspend(() =>
    shouldCancel().pipe(
      Effect.flatMap((cancel) =>
        cancel
          ? Effect.fail(new JobCancelled())
          : Effect.sleep(pollIntervalMs).pipe(Effect.andThen(waitForCancellation)),
      ),
    ),
  )
  return Effect.raceFirst(operation, waitForCancellation)
}

function leaseFailure<E>(cause: Cause.Cause<E>, attempt: number, now: () => Date) {
  const failedAt = now()
  const delay = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000)
  return {
    failedAt,
    runAt: new Date(failedAt.getTime() + delay),
    error: Cause.pretty(cause),
  }
}

function retryableFailure<E>(cause: Cause.Cause<E>): boolean {
  const failure = Option.getOrUndefined(Cause.failureOption(cause))
  return !(
    (failure instanceof AgentHarnessError || failure instanceof OpenCodeAutomationError) &&
    !failure.retryable
  )
}

function processReviewWork(
  work: ReviewWork,
  workerId: string,
  agentBranchPrefixes: ReadonlyArray<string>,
  fixWorkEnabled: boolean,
  onPrepared: (intent: AgentFailureContext) => void,
  onAbortFailure: () => void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const automation = yield* Automation
      const harness = yield* AgentHarness
      const workspaces = yield* Workspace
      const workspace = yield* workspaces.prepareReview(work)
      const requestedAt = new Date(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      const prepared = yield* automation.prepareReview(
        {
          directory: workspace.directory,
          repositoryFullName: work.repositoryFullName,
          pullRequestNumber: work.pullRequestNumber,
          baseSha: work.target.baseSha,
          headSha: work.target.headSha,
        },
        agentExecutionContext(work, workspace.directory, requestedAt),
      )
      onPrepared(prepared.launchIntent)
      const launch = yield* store.recordAgentLaunchIntent({
        jobId: work.id,
        workerId,
        recordedAt: requestedAt,
        intent: prepared.launchIntent,
      })
      if (launch === "stale") return launch
      const checkpoint = yield* Effect.acquireUseRelease(
        harness.createSession(prepared),
        (reference) =>
          Effect.gen(function* () {
            const referenceRecordedAt = new Date(
              yield* Effect.clockWith((clock) => clock.currentTimeMillis),
            )
            const session = yield* store.recordAgentSessionReference({
              jobId: work.id,
              workerId,
              recordedAt: referenceRecordedAt,
              reference,
            })
            return { reference, session }
          }),
        (reference, exit) =>
          Exit.isFailure(exit)
            ? Effect.exit(
                harness
                  .abortSession(reference)
                  .pipe(Effect.tapError(() => Effect.sync(onAbortFailure))),
              ).pipe(Effect.asVoid)
            : Effect.void,
      )
      const reference = checkpoint.reference
      const abortSession = () =>
        harness.abortSession(reference).pipe(Effect.tapError(() => Effect.sync(onAbortFailure)))
      const sessionResult = yield* Effect.gen(function* () {
        if (checkpoint.session === "stale") return { _tag: "Stale" } as const
        const review = yield* harness.resumeSession(prepared, reference)
        return { _tag: "Completed", review } as const
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Effect.exit(abortSession()).pipe(Effect.asVoid) : Effect.void,
        ),
      )
      if (sessionResult._tag === "Stale") {
        yield* abortSession()
        return "stale" as const
      }
      const review = sessionResult.review
      const completedAt = new Date(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      return yield* store.completeAgentReviewJob({
        jobId: work.id,
        workerId,
        sessionReferenceId: reference.sessionReferenceId,
        completedAt,
        review,
        autoFix:
          fixWorkEnabled &&
          decideFixEligibility({
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

function processFixWork(
  work: FixWork,
  workerId: string,
  onPrepared: (intent: AgentFailureContext) => void,
  onAbortFailure: () => void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      const automation = yield* Automation
      const harness = yield* AgentHarness
      const workspaces = yield* Workspace
      const workspace = yield* workspaces.prepareFix(work)
      let result = work.checkpoint
      if (workspace.recovery === "none" && result === undefined) {
        const requestedAt = new Date(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
        const prepared = yield* automation.prepareFix(
          {
            jobId: work.id,
            directory: workspace.directory,
            repositoryFullName: work.repositoryFullName,
            pullRequestNumber: work.pullRequestNumber,
            baseSha: work.target.baseSha,
            headSha: work.target.headSha,
          },
          agentExecutionContext(work, workspace.directory, requestedAt),
        )
        onPrepared(prepared.launchIntent)
        const launch = yield* store.recordAgentLaunchIntent({
          jobId: work.id,
          workerId,
          recordedAt: requestedAt,
          intent: prepared.launchIntent,
        })
        if (launch === "stale") return launch
        const checkpoint = yield* Effect.acquireUseRelease(
          harness.createSession(prepared),
          (reference) =>
            Effect.gen(function* () {
              const referenceRecordedAt = new Date(
                yield* Effect.clockWith((clock) => clock.currentTimeMillis),
              )
              const session = yield* store.recordAgentSessionReference({
                jobId: work.id,
                workerId,
                recordedAt: referenceRecordedAt,
                reference,
              })
              return { reference, session }
            }),
          (reference, exit) =>
            Exit.isFailure(exit)
              ? Effect.exit(
                  harness
                    .abortSession(reference)
                    .pipe(Effect.tapError(() => Effect.sync(onAbortFailure))),
                ).pipe(Effect.asVoid)
              : Effect.void,
        )
        const reference = checkpoint.reference
        const abortSession = () =>
          harness.abortSession(reference).pipe(Effect.tapError(() => Effect.sync(onAbortFailure)))
        const sessionResult = yield* Effect.gen(function* () {
          if (checkpoint.session === "stale") return { _tag: "Stale" } as const
          const fixResult = yield* harness.resumeSession(prepared, reference)
          return { _tag: "Completed", fixResult } as const
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Effect.exit(abortSession()).pipe(Effect.asVoid) : Effect.void,
          ),
        )
        if (sessionResult._tag === "Stale") {
          yield* abortSession()
          return "stale" as const
        }
        result = sessionResult.fixResult
        const recordedAt = new Date(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
        const recorded = yield* store.recordAgentFixResult({
          jobId: work.id,
          workerId,
          sessionReferenceId: reference.sessionReferenceId,
          recordedAt,
          result,
        })
        if (recorded === "stale") return "stale" as const
      }
      const controllerSigningFingerprint = yield* workspaces.publishFix(
        work,
        workspace,
        result,
        (now) =>
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
      const completedAt = new Date(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      const disposition = yield* store.completeFixJob({
        jobId: work.id,
        workerId,
        completedAt,
        ...(controllerSigningFingerprint === null ? {} : { controllerSigningFingerprint }),
      })
      if (disposition === "completed") workspace.markCompleted()
      return disposition
    }),
  )
}

function agentExecutionContext(work: ReviewWork | FixWork, directory: string, requestedAt: Date) {
  return {
    directory,
    scope: {
      _tag: "GenerationScope" as const,
      workflowId: `pr:${work.repositoryId}:${work.pullRequestNumber}`,
      generation: work.generation,
    },
    operationId: `job:${work.id}`,
    operationRevision: 1,
    attempt: work.attempt,
    leaseToken: randomUUID(),
    requestedAt,
  }
}

type AgentFailureContext = {
  readonly attempt: number
  readonly leaseToken: string
  readonly retryPolicy: { readonly maxAttempts: number }
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
    const harness = yield* AgentHarness
    while (true) {
      const expiredSession = yield* store.claimExpiredAgentSession({
        workerId: options.workerId,
        now: options.now(),
        leaseDurationMs: options.leaseDurationMs,
      })
      if (expiredSession === null) break
      const cleanup = yield* Effect.exit(harness.abortSession(expiredSession))
      if (Exit.isFailure(cleanup)) {
        yield* store.recordAgentSessionCleanupFailure({
          sessionReferenceId: expiredSession.sessionReferenceId,
          workerId: options.workerId,
          failedAt: options.now(),
          error: Cause.pretty(cleanup.cause),
        })
        yield* Effect.logWarning(
          `Could not abort expired agent session ${expiredSession.sessionReferenceId}: ${Cause.pretty(cleanup.cause)}`,
        )
        break
      }
      yield* store.supersedeAgentSession(expiredSession.sessionReferenceId, options.now())
    }
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

    let agentFailureContext: AgentFailureContext | undefined
    let agentAbortFailed = false
    const captureAgentFailureContext = (intent: AgentFailureContext) => {
      agentFailureContext = intent
    }
    const operation =
      work._tag === "ReviewWork"
        ? processReviewWork(
            work,
            options.workerId,
            options.agentBranchPrefixes,
            options.fixWorkEnabled,
            captureAgentFailureContext,
            () => {
              agentAbortFailed = true
            },
          )
        : processFixWork(work, options.workerId, captureAgentFailureContext, () => {
            agentAbortFailed = true
          })
    const exit = yield* Effect.exit(
      interruptOnCancellation(operation, options.cancellationPollIntervalMs, () =>
        store.shouldCancelJob(work.id, options.workerId, options.now()),
      ).pipe(
        Effect.timeoutFail({
          duration: options.timeoutMs,
          onTimeout: () => new Error(`Job ${work.id} timed out`),
        }),
      ),
    )
    if (Exit.isSuccess(exit)) return exit.value
    if (agentAbortFailed) return "cleanup_pending" as const

    return yield* store.rescheduleJob({
      jobId: work.id,
      workerId: options.workerId,
      ...leaseFailure(exit.cause, work.attempt, options.now),
      maxAttempts: retryableFailure(exit.cause)
        ? (agentFailureContext?.retryPolicy.maxAttempts ?? options.maxAttempts)
        : work.attempt,
      ...(agentFailureContext === undefined
        ? {}
        : {
            execution: {
              attempt: agentFailureContext.attempt,
              leaseToken: agentFailureContext.leaseToken,
            },
          }),
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
          store.isPublicationCurrent(publication.id, options.workerId, now),
        )
        .pipe(
          Effect.timeoutFail({
            duration: options.timeoutMs,
            onTimeout: () => new Error(`Publication ${publication.id} timed out`),
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

    const authorized = options.commandUsers.includes(command.commenter.toLowerCase())
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
            Effect.logInfo(`Command ${command.command} from ${command.commenter}: ${disposition}`),
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

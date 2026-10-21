import { OpenCodeAutomationError } from "./opencode"
import { randomUUID } from "node:crypto"
import { Cause, Data, Effect, Exit, Option } from "effect"
import { AgentHarness, AgentHarnessError } from "./agent-harness"
import { WorkflowStore } from "./store/contracts"
import type { FixWork, ReviewWork } from "./domain/work"

class JobCancelled extends Data.TaggedError("JobCancelled")<Record<never, never>> {}

export function interruptOnCancellation<A, E, R, CancellationError, CancellationRequirements>(
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

export function agentExecutionContext(
  work: ReviewWork | FixWork,
  directory: string,
  requestedAt: Date,
) {
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

export function cleanupExpiredAgentSessions(options: {
  readonly workerId: string
  readonly now: () => Date
  readonly leaseDurationMs: number
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
      if (expiredSession === null) return
      const cleanup = yield* Effect.exit(harness.abortSession(expiredSession))
      if (Exit.isSuccess(cleanup)) {
        yield* store.supersedeAgentSession(expiredSession.sessionReferenceId, options.now())
        continue
      }
      yield* store.recordAgentSessionCleanupFailure({
        sessionReferenceId: expiredSession.sessionReferenceId,
        workerId: options.workerId,
        failedAt: options.now(),
        error: Cause.pretty(cleanup.cause),
      })
      yield* Effect.logWarning(
        `Could not abort expired agent session ${expiredSession.sessionReferenceId}: ${Cause.pretty(cleanup.cause)}`,
      )
      return
    }
  })
}

export function retryableFailure<E>(cause: Cause.Cause<E>): boolean {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
  return !(
    (failure instanceof AgentHarnessError || failure instanceof OpenCodeAutomationError) &&
    !failure.retryable
  )
}

export function reviewerMayBeHung<E>(cause: Cause.Cause<E>): boolean {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (!(failure instanceof AgentHarnessError || failure instanceof OpenCodeAutomationError))
    return false
  return /timed?\s*out|timeout|transport|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket|connection (?:closed|refused|reset)/i.test(
    failure.cause.message,
  )
}

export function leaseFailure<E>(cause: Cause.Cause<E>, attempt: number, now: () => Date) {
  const failedAt = now()
  const delay = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000)
  return {
    failedAt,
    runAt: new Date(failedAt.getTime() + delay),
    error: Cause.pretty(cause),
  }
}

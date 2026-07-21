import { randomUUID } from "node:crypto"
import { Cause, Effect, Exit } from "effect"
import { AgentHarness, type AgentHarnessPort, type SessionReference } from "../agent-harness"
import { QrspiStore, type QrspiStorePort, type StageOperationLease } from "./store"
import { StageCatalogService, runStageContract, type StageCatalog } from "./stages"
import { QrspiWorkspace, type QrspiWorkspacePort } from "./workspace"

type StageHarnessDefinitions = Parameters<typeof runStageContract>[0]["harnessDefinitions"]
type StageHarnessDefinitionsSource =
  StageHarnessDefinitions | ((stage: StageOperationLease["stage"]) => StageHarnessDefinitions)

export function runStageProduceIteration(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly harnessDefinitions: StageHarnessDefinitionsSource
  readonly now?: () => Date
  readonly randomId?: () => string
}) {
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? randomUUID
  return Effect.gen(function* () {
    const store = yield* QrspiStore
    const harness = yield* AgentHarness
    const catalog = yield* StageCatalogService
    const workspace = yield* QrspiWorkspace
    return yield* runStageProduceIterationWith({
      ...options,
      store,
      harness,
      catalog,
      workspace,
      now,
      randomId,
    })
  })
}

export function runStageProduceIterationWith(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly workspace: QrspiWorkspacePort
  readonly harnessDefinitions: StageHarnessDefinitionsSource
  readonly store: Pick<
    QrspiStorePort,
    | "claimStageOperation"
    | "isStageOperationCurrent"
    | "rescheduleStageOperation"
    | "completeStageProduce"
    | "recordStageAgentLaunchIntent"
    | "recordStageAgentSessionReference"
    | "requireStageSessionCleanup"
  >
  readonly harness: AgentHarnessPort
  readonly catalog: StageCatalog
  readonly now: () => Date
  readonly randomId: () => string
}) {
  return Effect.gen(function* () {
    const { store, harness, catalog } = options
    let recordedSession: SessionReference | undefined
    let recordedLaunchIntentSessionReferenceId: string | undefined
    const work = yield* store.claimStageOperation(
      "StageProduce",
      options.workerId,
      options.randomId(),
      options.leaseDurationMs,
      options.now(),
    )
    if (work === null) return "idle" as const
    if (!(yield* store.isStageOperationCurrent(work.operationId, work.leaseToken, options.now()))) {
      return "stale" as const
    }

    const execution = yield* Effect.exit(
      options.workspace.withWorkspace(
        {
          repository: work.repository,
          workflowId: work.scope.workflowId,
          headRef: work.headRef,
          targetSha: work.currentHeadSha,
        },
        (directory) =>
          runStageContract({
            catalog,
            harness,
            harnessDefinitions:
              typeof options.harnessDefinitions === "function"
                ? options.harnessDefinitions(work.stage)
                : options.harnessDefinitions,
            stage: work.stage,
            ticketId: work.ticketId,
            input: {
              ticketRevisionSha256: work.input.ticketRevisionSha256,
              readyTicket: work.readyTicket,
              sources: work.input.sources ?? [],
              ...(work.input.stepPosition === undefined
                ? {}
                : { stepPosition: work.input.stepPosition }),
              ...(work.implementationCommits === undefined
                ? {}
                : { implementationCommits: work.implementationCommits }),
              ...(work.predecessorSessionReferenceId === undefined
                ? {}
                : { predecessorSessionReferenceId: work.predecessorSessionReferenceId }),
              ...(work.input.feedback === undefined ? {} : { feedback: work.input.feedback }),
            },
            context: {
              directory,
              scope: work.scope,
              operationId: work.operationId,
              operationRevision: work.operationRevision,
              attempt: work.attempt,
              leaseToken: work.leaseToken,
              requestedAt: options.now(),
            },
            onLaunchIntent: (launchIntent) =>
              store
                .recordStageAgentLaunchIntent({
                  operationId: work.operationId,
                  leaseToken: work.leaseToken,
                  launchIntent,
                  now: options.now(),
                })
                .pipe(
                  Effect.tap((disposition) =>
                    disposition === "recorded"
                      ? Effect.sync(
                          () =>
                            void (recordedLaunchIntentSessionReferenceId =
                              launchIntent.sessionReferenceId),
                        )
                      : Effect.void,
                  ),
                ),
            onSessionCreated: (reference) =>
              store
                .recordStageAgentSessionReference({
                  operationId: work.operationId,
                  leaseToken: work.leaseToken,
                  reference,
                  now: options.now(),
                })
                .pipe(
                  Effect.tap((disposition) =>
                    disposition === "recorded"
                      ? Effect.sync(() => void (recordedSession = reference))
                      : Effect.void,
                  ),
                ),
          }),
      ),
    )
    if (Exit.isFailure(execution)) {
      if (recordedSession === undefined && recordedLaunchIntentSessionReferenceId !== undefined) {
        return yield* store.requireStageSessionCleanup({
          operationId: work.operationId,
          leaseToken: work.leaseToken,
          sessionReferenceId: recordedLaunchIntentSessionReferenceId,
          error: "agent session creation requires operator confirmation",
          now: options.now(),
        })
      }
      if (recordedSession !== undefined) {
        const cleanup = yield* Effect.exit(harness.abortSession(recordedSession))
        if (Exit.isFailure(cleanup)) {
          return yield* store.requireStageSessionCleanup({
            operationId: work.operationId,
            leaseToken: work.leaseToken,
            sessionReferenceId: recordedSession.sessionReferenceId,
            error: "recorded agent session cleanup requires operator confirmation",
            now: options.now(),
          })
        }
      }
      const failedAt = options.now()
      return yield* store.rescheduleStageOperation({
        operationId: work.operationId,
        leaseToken: work.leaseToken,
        error: Cause.pretty(execution.cause),
        runAt: new Date(failedAt.getTime() + work.stage.producer.retry.backoffMs),
        now: failedAt,
        ...(recordedSession === undefined
          ? {}
          : { confirmedAbortedSessionReferenceId: recordedSession.sessionReferenceId }),
      })
    }
    if (!(yield* store.isStageOperationCurrent(work.operationId, work.leaseToken, options.now()))) {
      return "stale" as const
    }
    return yield* store.completeStageProduce({
      operationId: work.operationId,
      leaseToken: work.leaseToken,
      preparedResult: execution.value.result,
      sessionReferenceId: execution.value.sessionReference.sessionReferenceId,
      now: options.now(),
    })
  })
}

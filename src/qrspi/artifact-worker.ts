import { createHash, randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Schema } from "effect"
import { QrspiStore, type QrspiStorePort } from "./store"
import {
  ArtifactPublication,
  ArtifactRefConflictError,
  ArtifactPublicationRepositoryFactoryService,
  type ArtifactPublicationRepository,
} from "./artifact-publication"
import {
  DocumentStageResult,
  ImplementationCheckpointReference,
  ImplementationStageResult,
  resolveArtifactDestination,
  validatePreparedDeliveryEvidence,
} from "./stages"
import { canonicalSha256 } from "./domain"
import { QrspiWorkspace, type QrspiWorkspacePort } from "./workspace"

export function runArtifactPublishIteration(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly now?: () => Date
  readonly randomId?: () => string
}) {
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? randomUUID
  return Effect.gen(function* () {
    const store = yield* QrspiStore
    const workspace = yield* QrspiWorkspace
    const repositoryFactory = yield* ArtifactPublicationRepositoryFactoryService
    return yield* runArtifactPublishIterationWith({
      ...options,
      store,
      workspace,
      repositoryForDirectory: repositoryFactory.forDirectory,
      now,
      randomId,
    })
  })
}

export function runArtifactPublishIterationWith(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly store: Pick<
    QrspiStorePort,
    | "findArtifactPublicationRecovery"
    | "claimStageOperation"
    | "isStageOperationCurrent"
    | "bindArtifactPublication"
    | "completeArtifactPublication"
    | "bindImplementationPublication"
    | "completeImplementationPublication"
    | "rescheduleStageOperation"
    | "recordArtifactPublicationOutcome"
  >
  readonly repository?: ArtifactPublicationRepository
  readonly workspace?: QrspiWorkspacePort
  readonly repositoryForDirectory?: (directory: string) => ArtifactPublicationRepository
  readonly now: () => Date
  readonly randomId: () => string
}) {
  return Effect.gen(function* () {
    const { store } = options
    const recovery = yield* store.findArtifactPublicationRecovery()
    const work =
      recovery ??
      (yield* store.claimStageOperation(
        "ArtifactPublish",
        options.workerId,
        options.randomId(),
        options.leaseDurationMs,
        options.now(),
      ))
    if (work === null) return "idle" as const
    if (work.sessionReferenceId === undefined) {
      return yield* Effect.fail(new Error("ArtifactPublish is missing its producer session"))
    }
    const sessionReferenceId = work.sessionReferenceId
    const publish = (repository: ArtifactPublicationRepository) =>
      Effect.gen(function* () {
        if (work.stage.kind === "implementation") {
          const trailers = [
            ["Provenance-Version", "1"],
            ["Ticket", work.ticketId],
            ["Workflowd-Job", work.operationId],
            ["Session", sessionReferenceId],
            ["Harness", `${work.stage.producer.harnessId}@${work.stage.producer.harnessVersion}`],
            ["Agent", work.stage.producer.agent],
            ["Model", work.stage.producer.model],
          ] as const
          const recoveredCommit =
            recovery !== null && "implementationCommit" in recovery
              ? recovery.implementationCommit
              : undefined
          const preparePublication = Effect.gen(function* () {
            const prepared = yield* Schema.decodeUnknown(ImplementationStageResult)(
              work.preparedResult,
            )
            if (prepared.final && prepared.deliveryEvidence === undefined) {
              return yield* Effect.fail(
                new Error("Implementation checkpoint requires final delivery evidence"),
              )
            }
            if (prepared.final) {
              yield* Effect.try({
                try: () =>
                  validatePreparedDeliveryEvidence(work.readyTicket, prepared.deliveryEvidence!),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              })
            }
            const finalize = repository.finalizeImplementation
            if (finalize === undefined) {
              return yield* Effect.fail(new Error("Implementation publisher is unavailable"))
            }
            const finalized =
              recoveredCommit === undefined
                ? yield* finalize({
                    operationId: work.operationId,
                    candidateSha: prepared.candidateSha,
                    expectedParentSha: work.currentHeadSha,
                    expectedChangedPaths: prepared.changedPaths,
                    trustedTrailers: trailers,
                  })
                : { finalSha: recoveredCommit.commitSha, parentSha: recoveredCommit.parentSha }
            const commit = recoveredCommit ?? {
              position: (work.implementationCommits?.length ?? 0) + 1,
              commitSha: finalized.finalSha,
              parentSha: finalized.parentSha,
              changedPaths: prepared.changedPaths,
              operationId: work.operationId,
            }
            const commits = [...(work.implementationCommits ?? []), commit]
            const checkpoint = prepared.final
              ? yield* Schema.decodeUnknown(ImplementationCheckpointReference)({
                  repository: work.repository,
                  workflowId: work.scope.workflowId,
                  generation: work.scope.generation,
                  stageKey: work.stage.key,
                  stageRevision: work.input.stageRevision,
                  checkpointId: `checkpoint:${work.operationId}`,
                  baseSha: commits[0]!.parentSha,
                  finalSha: commit.commitSha,
                  commits,
                  changedPaths: [...new Set(commits.flatMap(({ changedPaths }) => changedPaths))],
                  preparedDeliveryEvidenceSha256: canonicalSha256(prepared.deliveryEvidence!),
                })
              : undefined
            const binding =
              recoveredCommit === undefined
                ? yield* store.bindImplementationPublication({
                    operationId: work.operationId,
                    leaseToken: work.leaseToken,
                    expectedOld: work.currentHeadSha,
                    commit,
                    now: options.now(),
                  })
                : "bound"
            return { prepared, commit, checkpoint, binding }
          })
          const preparedPublication =
            recoveredCommit === undefined
              ? yield* Effect.exit(preparePublication)
              : Exit.succeed(yield* preparePublication)
          if (Exit.isFailure(preparedPublication)) {
            const failedAt = options.now()
            return yield* store.rescheduleStageOperation({
              operationId: work.operationId,
              leaseToken: work.leaseToken,
              error: Cause.pretty(preparedPublication.cause),
              runAt: new Date(failedAt.getTime() + work.stage.producer.retry.backoffMs),
              now: failedAt,
            })
          }
          const { prepared, commit, checkpoint, binding } = preparedPublication.value
          if (binding !== "bound") return binding
          yield* repository.advanceLocalWorktree({
            candidateSha: prepared.candidateSha,
            finalSha: commit.commitSha,
          })
          if (
            !(yield* store.isStageOperationCurrent(
              work.operationId,
              work.leaseToken,
              options.now(),
            ))
          ) {
            return "stale" as const
          }
          const update = yield* repository
            .updateRefExact({
              headRef: work.headRef,
              expectedOld: work.currentHeadSha,
              newSha: commit.commitSha,
              fastForwardOnly: true,
            })
            .pipe(
              Effect.as("updated" as const),
              Effect.catchAll((error) =>
                Effect.succeed(
                  error instanceof ArtifactRefConflictError ? "conflict" : "uncertain",
                ),
              ),
            )
          const observed = yield* repository.observeRef(work.headRef)
          if (observed !== commit.commitSha) {
            return yield* store.recordArtifactPublicationOutcome({
              operationId: work.operationId,
              outcome:
                update === "conflict" || (observed !== null && observed !== work.currentHeadSha)
                  ? "conflict"
                  : "uncertain",
              observedHeadSha: observed,
              now: options.now(),
            })
          }
          if (
            !(yield* store.isStageOperationCurrent(
              work.operationId,
              work.leaseToken,
              options.now(),
            ))
          ) {
            return "stale" as const
          }
          return yield* store.completeImplementationPublication({
            operationId: work.operationId,
            expectedOld: work.currentHeadSha,
            commit,
            ...(checkpoint === undefined ? {} : { checkpoint }),
            observedHeadSha: observed,
            now: options.now(),
          })
        }
        if (work.stage.outputContract._tag !== "Artifact") {
          return yield* Effect.fail(new Error("Document stage must publish an artifact"))
        }
        const prepared = yield* Schema.decodeUnknown(DocumentStageResult)(work.preparedResult)
        const destination = resolveArtifactDestination(work.stage, work.ticketId)!
        const path = destination.path
        const contentSha256 = createHash("sha256").update(prepared.content).digest("hex")
        const publication = yield* Effect.exit(
          ArtifactPublication.publish(
            {
              operationId: work.operationId,
              headRef: work.headRef,
              expectedOld: work.currentHeadSha,
              candidateSha: prepared.candidateSha,
              expectedPath: path,
              expectedContentSha256: contentSha256,
              artifactIdentity: {
                repository: work.repository,
                workflowId: work.scope.workflowId,
                generation: work.scope.generation,
                stageKey: work.stage.key,
                stageRevision: work.input.stageRevision,
                path,
                mediaType: destination.mediaType,
              },
              trustedTrailers: [
                ["Provenance-Version", "1"],
                ["Ticket", work.ticketId],
                ["Workflowd-Job", work.operationId],
                ["Session", sessionReferenceId],
                [
                  "Harness",
                  `${work.stage.producer.harnessId}@${work.stage.producer.harnessVersion}`,
                ],
                ["Agent", work.stage.producer.agent],
                ["Model", work.stage.producer.model],
              ],
              ...(recovery !== null && "bound" in recovery ? { bound: recovery.bound } : {}),
            },
            {
              repository,
              isCurrent: () =>
                store.isStageOperationCurrent(work.operationId, work.leaseToken, options.now()),
              bind: (bound) =>
                store.bindArtifactPublication({
                  operationId: work.operationId,
                  leaseToken: work.leaseToken,
                  expectedOld: work.currentHeadSha,
                  finalSha: bound.finalSha,
                  artifact: bound.artifact,
                  now: options.now(),
                }),
              complete: (bound) =>
                store.completeArtifactPublication({
                  operationId: work.operationId,
                  expectedOld: work.currentHeadSha,
                  finalSha: bound.finalSha,
                  artifact: bound.artifact,
                  observedHeadSha: bound.finalSha,
                  now: options.now(),
                }),
            },
          ),
        )
        if (Exit.isSuccess(publication)) {
          if (
            publication.value._tag === "Conflict" ||
            publication.value._tag === "WaitingExternal"
          ) {
            return yield* store.recordArtifactPublicationOutcome({
              operationId: work.operationId,
              outcome: publication.value._tag === "Conflict" ? "conflict" : "uncertain",
              observedHeadSha:
                publication.value._tag === "WaitingExternal" ? publication.value.observed : null,
              now: options.now(),
            })
          }
          return publication.value._tag
        }
        const failedAt = options.now()
        return yield* store.rescheduleStageOperation({
          operationId: work.operationId,
          leaseToken: work.leaseToken,
          error: Cause.pretty(publication.cause),
          runAt: new Date(failedAt.getTime() + work.stage.producer.retry.backoffMs),
          now: failedAt,
        })
      })
    if (options.workspace !== undefined && options.repositoryForDirectory !== undefined) {
      const target = yield* Schema.decodeUnknown(
        Schema.Struct({
          candidateSha: Schema.String.pipe(Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
        }),
      )(work.preparedResult)
      return yield* options.workspace.withWorkspace(
        {
          repository: work.repository,
          workflowId: work.scope.workflowId,
          headRef: work.headRef,
          targetSha: target.candidateSha,
        },
        (directory) => publish(options.repositoryForDirectory!(directory)),
      )
    }
    if (options.repository === undefined) {
      return yield* Effect.fail(new Error("Artifact publication workspace is unavailable"))
    }
    return yield* publish(options.repository)
  })
}

import { createHash, randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Schema } from "effect"
import { QrspiStore, type QrspiStorePort } from "./store"
import {
  ArtifactPublication,
  ArtifactRefConflictError,
  ArtifactPublicationRepositoryService,
  type ArtifactPublicationRepository,
} from "./artifact-publication"
import { DocumentStageResult, ImplementationStageResult } from "./stages"
import { canonicalSha256 } from "./domain"

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
    const repository = yield* ArtifactPublicationRepositoryService
    return yield* runArtifactPublishIterationWith({
      ...options,
      store,
      repository,
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
  readonly repository: ArtifactPublicationRepository
  readonly now: () => Date
  readonly randomId: () => string
}) {
  return Effect.gen(function* () {
    const { store, repository } = options
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
    if (work.stage.kind === "implementation") {
      const prepared = yield* Schema.decodeUnknown(ImplementationStageResult)(work.preparedResult)
      if (prepared.final && prepared.deliveryEvidence === undefined) {
        return yield* Effect.fail(
          new Error("Implementation checkpoint requires final delivery evidence"),
        )
      }
      const finalize = repository.finalizeImplementation
      if (finalize === undefined) {
        return yield* Effect.fail(new Error("Implementation publisher is unavailable"))
      }
      const trailers = [
        ["Provenance-Version", "1"],
        ["Ticket", work.ticketId],
        ["Workflowd-Job", work.operationId],
        ["Session", work.sessionReferenceId],
        ["Harness", `${work.stage.producer.harnessId}@${work.stage.producer.harnessVersion}`],
        ["Agent", work.stage.producer.agent],
        ["Model", work.stage.producer.model],
      ] as const
      const recoveredCommit =
        recovery !== null && "implementationCommit" in recovery
          ? recovery.implementationCommit
          : undefined
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
      if (recoveredCommit === undefined) {
        const binding = yield* store.bindImplementationPublication({
          operationId: work.operationId,
          leaseToken: work.leaseToken,
          expectedOld: work.currentHeadSha,
          commit,
          now: options.now(),
        })
        if (binding !== "bound") return binding
      }
      yield* repository.advanceLocalWorktree({
        candidateSha: prepared.candidateSha,
        finalSha: commit.commitSha,
      })
      if (
        !(yield* store.isStageOperationCurrent(work.operationId, work.leaseToken, options.now()))
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
            Effect.succeed(error instanceof ArtifactRefConflictError ? "conflict" : "uncertain"),
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
        !(yield* store.isStageOperationCurrent(work.operationId, work.leaseToken, options.now()))
      ) {
        return "stale" as const
      }
      const commits = [...(work.implementationCommits ?? []), commit]
      const checkpoint = prepared.final
        ? {
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
          }
        : undefined
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
    const path = work.stage.outputContract.pathTemplate
      .replaceAll("{ticketId}", work.ticketId)
      .replaceAll("{stageKey}", work.stage.key)
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
            mediaType: work.stage.outputContract.mediaType,
          },
          trustedTrailers: [
            ["Provenance-Version", "1"],
            ["Ticket", work.ticketId],
            ["Workflowd-Job", work.operationId],
            ["Session", work.sessionReferenceId],
            ["Harness", `${work.stage.producer.harnessId}@${work.stage.producer.harnessVersion}`],
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
      if (publication.value._tag === "Conflict" || publication.value._tag === "WaitingExternal") {
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
}

import { randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Schema } from "effect"
import { RepositoryReference } from "./domain"
import {
  QrspiRepository,
  type FinalPullRequestIntent,
  type FinalPullRequestObservation,
} from "./ports"
import { QrspiStore, type QrspiStorePort } from "./store"
import { ImplementationCheckpointReference, PreparedDeliveryEvidence } from "./stages"

const PrePullRequestVerifyInput = Schema.Struct({
  checkpoint: ImplementationCheckpointReference,
  headSha: Schema.String,
  preparedDeliveryEvidenceSha256: Schema.String,
})

const PullRequestPublishInput = Schema.Struct({
  repository: RepositoryReference,
  baseRef: Schema.NonEmptyString,
  headRef: Schema.NonEmptyString,
  headSha: Schema.String,
  title: Schema.NonEmptyString,
  body: Schema.String,
  bodySha256: Schema.String,
  draft: Schema.Literal(false),
  checkpoint: ImplementationCheckpointReference,
  preparedDeliveryEvidence: PreparedDeliveryEvidence,
  verificationOperationId: Schema.NonEmptyString,
})

type FinalizationWorkerOptions = {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly now?: () => Date
  readonly randomId?: () => string
}

export function runPrePullRequestVerifyIteration(options: FinalizationWorkerOptions) {
  return Effect.gen(function* () {
    const store = yield* QrspiStore
    const repository = yield* QrspiRepository
    return yield* runPrePullRequestVerifyIterationWith({
      ...options,
      store,
      repository,
      now: options.now ?? (() => new Date()),
      randomId: options.randomId ?? randomUUID,
    })
  })
}

export function runPrePullRequestVerifyIterationWith(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly now: () => Date
  readonly randomId: () => string
  readonly store: Pick<
    QrspiStorePort,
    | "claimFinalizationOperation"
    | "completePrePullRequestVerification"
    | "rescheduleFinalizationOperation"
  >
  readonly repository: typeof QrspiRepository.Service
}) {
  return Effect.gen(function* () {
    const work = yield* options.store.claimFinalizationOperation(
      "PrePullRequestVerify",
      options.workerId,
      options.randomId(),
      options.leaseDurationMs,
      options.now(),
    )
    if (work === null) return "idle" as const
    const verification = yield* Schema.decodeUnknown(PrePullRequestVerifyInput)(work.input)
    const result = yield* Effect.exit(
      options.repository.observeBranch({ repository: work.repository, headRef: work.headRef }),
    )
    if (Exit.isFailure(result)) {
      const failedAt = options.now()
      return yield* options.store.rescheduleFinalizationOperation({
        operationId: work.operationId,
        leaseToken: work.leaseToken!,
        error: Cause.pretty(result.cause),
        runAt: new Date(failedAt.getTime() + 1_000),
        now: failedAt,
      })
    }
    if (result.value?.sha !== verification.headSha) {
      const failedAt = options.now()
      return yield* options.store.rescheduleFinalizationOperation({
        operationId: work.operationId,
        leaseToken: work.leaseToken!,
        error: "ticket branch does not match the implementation checkpoint",
        runAt: new Date(failedAt.getTime() + 1_000),
        now: failedAt,
      })
    }
    return yield* options.store.completePrePullRequestVerification({
      operationId: work.operationId,
      leaseToken: work.leaseToken!,
      observedHeadSha: result.value.sha,
      now: options.now(),
    })
  })
}

export function runPullRequestPublishIteration(options: FinalizationWorkerOptions) {
  return Effect.gen(function* () {
    const store = yield* QrspiStore
    const repository = yield* QrspiRepository
    return yield* runPullRequestPublishIterationWith({
      ...options,
      store,
      repository,
      now: options.now ?? (() => new Date()),
      randomId: options.randomId ?? randomUUID,
    })
  })
}

export function runPullRequestPublishIterationWith(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly now: () => Date
  readonly randomId: () => string
  readonly store: Pick<
    QrspiStorePort,
    | "claimFinalizationOperation"
    | "findPullRequestPublicationRecovery"
    | "bindPullRequestPublication"
    | "bindPullRequestPublicationReference"
    | "isFinalizationOperationCurrent"
    | "completePullRequestPublication"
    | "recordStalePullRequestPublicationEffect"
  >
  readonly repository: typeof QrspiRepository.Service
}) {
  return Effect.gen(function* () {
    const recovery = yield* options.store.findPullRequestPublicationRecovery()
    const work =
      recovery ??
      (yield* options.store.claimFinalizationOperation(
        "PullRequestPublish",
        options.workerId,
        options.randomId(),
        options.leaseDurationMs,
        options.now(),
      ))
    if (work === null) return "idle" as const
    const publication = yield* Schema.decodeUnknown(PullRequestPublishInput)(work.input)
    const intent: FinalPullRequestIntent = {
      repository: publication.repository,
      baseRef: publication.baseRef,
      headRef: publication.headRef,
      headSha: publication.headSha,
      title: publication.title,
      body: publication.body,
      bodySha256: publication.bodySha256,
      draft: false,
    }
    if (recovery === null) {
      const binding = yield* options.store.bindPullRequestPublication({
        operationId: work.operationId,
        leaseToken: work.leaseToken!,
        intent,
        now: options.now(),
      })
      if (binding !== "bound") return binding
    }
    let observed =
      work.publicationReference === undefined
        ? yield* options.repository.observeFinalPullRequest(intent)
        : yield* options.repository.observeFinalPullRequestReference(work.publicationReference)
    let created: FinalPullRequestObservation["reference"] | undefined
    if (observed === null) {
      if (!(yield* options.store.isFinalizationOperationCurrent(work.operationId, options.now()))) {
        return "stale" as const
      }
      created = yield* options.repository.createFinalPullRequest(intent)
      const referenceBinding = yield* options.store.bindPullRequestPublicationReference({
        operationId: work.operationId,
        reference: created,
        now: options.now(),
      })
      if (referenceBinding !== "bound") {
        return yield* options.store.recordStalePullRequestPublicationEffect({
          operationId: work.operationId,
          intent,
          reference: created,
          now: options.now(),
        })
      }
      const observation = yield* Effect.exit(
        options.repository.observeFinalPullRequestReference(created),
      )
      if (Exit.isFailure(observation)) {
        if (
          !(yield* options.store.isFinalizationOperationCurrent(work.operationId, options.now()))
        ) {
          return yield* options.store.recordStalePullRequestPublicationEffect({
            operationId: work.operationId,
            intent,
            reference: created,
            now: options.now(),
          })
        }
        return yield* Effect.failCause(observation.cause)
      }
      observed = observation.value
    }
    if (observed === null) {
      if (
        created !== undefined &&
        !(yield* options.store.isFinalizationOperationCurrent(work.operationId, options.now()))
      ) {
        return yield* options.store.recordStalePullRequestPublicationEffect({
          operationId: work.operationId,
          intent,
          reference: created,
          now: options.now(),
        })
      }
      return yield* Effect.fail(new Error("final pull request was not observable after creation"))
    }
    if (!matchesIntent(observed, intent)) {
      return yield* options.store.recordStalePullRequestPublicationEffect({
        operationId: work.operationId,
        intent,
        reference: observed.reference,
        observation: observed,
        now: options.now(),
      })
    }
    if (!(yield* options.store.isFinalizationOperationCurrent(work.operationId, options.now()))) {
      return yield* options.store.recordStalePullRequestPublicationEffect({
        operationId: work.operationId,
        intent,
        reference: observed.reference,
        observation: observed,
        now: options.now(),
      })
    }
    const completion = yield* options.store.completePullRequestPublication({
      operationId: work.operationId,
      observation: observed,
      now: options.now(),
    })
    if (completion !== "stale") return completion
    return yield* options.store.recordStalePullRequestPublicationEffect({
      operationId: work.operationId,
      intent,
      reference: observed.reference,
      observation: observed,
      now: options.now(),
    })
  })
}

function matchesIntent(
  observation: FinalPullRequestObservation,
  intent: FinalPullRequestIntent,
): boolean {
  return (
    !observation.draft &&
    observation.headSha === intent.headSha &&
    observation.headRef === intent.headRef &&
    observation.baseRef === intent.baseRef &&
    observation.bodySha256 === intent.bodySha256
  )
}

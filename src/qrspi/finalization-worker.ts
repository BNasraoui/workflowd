import { randomUUID } from "node:crypto"
import { Cause, Effect, Either, Exit, Schema } from "effect"
import { RepositoryReference } from "./domain"
import {
  QrspiRepository,
  type FinalPullRequestIntent,
  type FinalPullRequestObservation,
} from "./ports"
import { QrspiStore, type QrspiStorePort } from "./store"
import { ImplementationCheckpointReference, PreparedDeliveryEvidence } from "./stages"
import { GitHub, type GitHubPort } from "../github"
import { WorkflowStore, type WorkflowStorePort } from "../store/contracts"

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
    | "recordPullRequestPublicationFailure"
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
    const initialObservation = yield* Effect.either(
      work.publicationReference === undefined
        ? options.repository.observeFinalPullRequest(intent)
        : options.repository.observeFinalPullRequestReference(work.publicationReference),
    )
    if (Either.isLeft(initialObservation)) {
      return yield* options.store.recordPullRequestPublicationFailure({
        operationId: work.operationId,
        error: Cause.pretty(Cause.fail(initialObservation.left)),
        now: options.now(),
      })
    }
    let observed = initialObservation.right
    let created: FinalPullRequestObservation["reference"] | undefined
    if (observed === null) {
      if (!(yield* options.store.isFinalizationOperationCurrent(work.operationId, options.now()))) {
        return "stale" as const
      }
      const branch = yield* Effect.either(
        options.repository.observeBranch({
          repository: intent.repository,
          headRef: intent.headRef,
        }),
      )
      if (Either.isLeft(branch)) {
        return yield* options.store.recordPullRequestPublicationFailure({
          operationId: work.operationId,
          error: Cause.pretty(Cause.fail(branch.left)),
          now: options.now(),
        })
      }
      if (branch.right?.sha !== intent.headSha) {
        return yield* options.store.recordPullRequestPublicationFailure({
          operationId: work.operationId,
          error: "ticket branch advanced after pre-pull-request verification",
          now: options.now(),
        })
      }
      const creation = yield* Effect.either(options.repository.createFinalPullRequest(intent))
      if (Either.isLeft(creation)) {
        return yield* options.store.recordPullRequestPublicationFailure({
          operationId: work.operationId,
          error: Cause.pretty(Cause.fail(creation.left)),
          now: options.now(),
        })
      }
      created = creation.right
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
      const observation = yield* Effect.either(
        options.repository.observeFinalPullRequestReference(created),
      )
      if (Either.isLeft(observation)) {
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
        return yield* options.store.recordPullRequestPublicationFailure({
          operationId: work.operationId,
          error: Cause.pretty(Cause.fail(observation.left)),
          now: options.now(),
        })
      }
      observed = observation.right
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
      return yield* options.store.recordPullRequestPublicationFailure({
        operationId: work.operationId,
        error: "final pull request was not observable after creation",
        now: options.now(),
      })
    }
    if (!matchesIntent(observed, intent)) {
      if (created !== undefined && observed.headSha !== intent.headSha) {
        yield* Effect.either(options.repository.closeFinalPullRequest(created))
      }
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

export function runGenericReviewHandoffIteration(
  options: FinalizationWorkerOptions & { readonly installationId: number },
) {
  return Effect.gen(function* () {
    const store = yield* QrspiStore
    const workflowStore = yield* WorkflowStore
    const github = yield* GitHub
    return yield* runGenericReviewHandoffIterationWith({
      ...options,
      store,
      workflowStore,
      github,
      now: options.now ?? (() => new Date()),
      randomId: options.randomId ?? randomUUID,
    })
  })
}

export function runGenericReviewHandoffIterationWith(options: {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly installationId: number
  readonly now: () => Date
  readonly randomId: () => string
  readonly store: Pick<
    QrspiStorePort,
    | "claimGenericReviewHandoff"
    | "isGenericReviewHandoffCurrent"
    | "completeGenericReviewHandoff"
    | "failGenericReviewHandoff"
  >
  readonly workflowStore: Pick<WorkflowStorePort, "ingestPullRequestSnapshot">
  readonly github: GitHubPort
}) {
  return Effect.gen(function* () {
    const work = yield* options.store.claimGenericReviewHandoff(
      options.workerId,
      options.randomId(),
      options.leaseDurationMs,
      options.now(),
    )
    if (work === null) return "idle" as const
    const snapshot = yield* Effect.either(
      options.github.fetchPullRequestSnapshot({
        installationId: options.installationId,
        repositoryFullName: work.pullRequest.reference.repository.repositoryFullName,
        pullRequestNumber: work.pullRequest.reference.number,
      }),
    )
    if (Either.isLeft(snapshot)) {
      return yield* options.store.failGenericReviewHandoff({
        operationId: work.operationId,
        leaseToken: work.leaseToken,
        error: Cause.pretty(Cause.fail(snapshot.left)),
        now: options.now(),
      })
    }
    if (
      !(yield* options.store.isGenericReviewHandoffCurrent(
        work.operationId,
        work.leaseToken,
        options.now(),
      ))
    ) {
      return "stale" as const
    }
    const handoff = yield* Effect.either(
      options.workflowStore.ingestPullRequestSnapshot({
        snapshot: snapshot.right,
        observedAt: options.now(),
      }),
    )
    if (Either.isLeft(handoff)) {
      return yield* options.store.failGenericReviewHandoff({
        operationId: work.operationId,
        leaseToken: work.leaseToken,
        error: Cause.pretty(Cause.fail(handoff.left)),
        now: options.now(),
      })
    }
    return yield* options.store.completeGenericReviewHandoff({
      operationId: work.operationId,
      leaseToken: work.leaseToken,
      now: options.now(),
    })
  })
}

function matchesIntent(
  observation: FinalPullRequestObservation,
  intent: FinalPullRequestIntent,
): boolean {
  return (
    observation.state === "open" &&
    observation.title === intent.title &&
    !observation.draft &&
    observation.headSha === intent.headSha &&
    observation.headRef === intent.headRef &&
    observation.baseRef === intent.baseRef &&
    observation.bodySha256 === intent.bodySha256
  )
}

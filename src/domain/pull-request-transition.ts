import { Data, Schema } from "effect"
import {
  GenerationNumber,
  PullRequestNumber,
  RepositoryId,
  ReviewRequestNumber,
} from "./identifiers"
import { ReviewTarget } from "./review-target"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const PositiveInt = Schema.Int.pipe(Schema.positive())

export const RepositoryRef = Schema.Struct({
  id: RepositoryId,
  fullName: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
}).annotations(exact)
export type RepositoryRef = typeof RepositoryRef.Type

export const PullRequestRef = Schema.Struct({
  number: PullRequestNumber,
  author: Schema.NonEmptyString,
  ...ReviewTarget.fields,
  draft: Schema.Boolean,
  state: Schema.Literal("open", "closed"),
  updatedAt: Schema.optional(Schema.NonEmptyString),
}).annotations(exact)
type PullRequestRef = typeof PullRequestRef.Type

export const PullRequestData = Schema.Struct({
  repository: RepositoryRef,
  pullRequest: PullRequestRef,
}).annotations(exact)
export type PullRequestData = typeof PullRequestData.Type

export const PullRequestObservation = Schema.TaggedStruct("PullRequest", {
  action: Schema.NonEmptyString,
  installationId: PositiveInt,
  ...PullRequestData.fields,
}).annotations(exact)
export type PullRequestObservation = typeof PullRequestObservation.Type

export const AuthoritativePullRequestSnapshot = Schema.TaggedStruct(
  "AuthoritativePullRequestSnapshot",
  {
    installationId: PositiveInt,
    ...PullRequestData.fields,
  },
).annotations(exact)
export type AuthoritativePullRequestSnapshot = typeof AuthoritativePullRequestSnapshot.Type

export const TrackedPullRequestState = Schema.TaggedStruct("TrackedPullRequestState", {
  installationId: PositiveInt,
  ...PullRequestData.fields,
  generation: GenerationNumber,
  latestReviewRequestNumber: Schema.optional(ReviewRequestNumber),
  reviewRequestActive: Schema.Boolean,
}).annotations(exact)
export type TrackedPullRequestState = typeof TrackedPullRequestState.Type

export type PullRequestTransitionIntent = Data.TaggedEnum<{
  QueueReview: { readonly reviewRequestNumber: ReviewRequestNumber }
  SupersedeGeneration: { readonly generation: GenerationNumber }
  SupersedeReviewRequests: {
    readonly generation: GenerationNumber
    readonly scope: "current-generation" | "earlier-review-requests"
  }
}>

export const PullRequestTransitionIntent = Data.taggedEnum<PullRequestTransitionIntent>()

export type PullRequestTransitionDecision = Data.TaggedEnum<{
  IgnoreObservation: { readonly generation: GenerationNumber }
  RequestReconciliation: { readonly generation: GenerationNumber }
  ApplySnapshot: {
    readonly snapshot: PullRequestObservation | AuthoritativePullRequestSnapshot
    readonly generation: GenerationNumber
    readonly intents: ReadonlyArray<PullRequestTransitionIntent>
  }
}>

export const PullRequestTransitionDecision = Data.taggedEnum<PullRequestTransitionDecision>()

const reviewableActions = new Set([
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
  "edited",
])

const targetOf = (pullRequest: PullRequestRef): ReviewTarget => ({
  baseSha: pullRequest.baseSha,
  baseRef: pullRequest.baseRef,
  headSha: pullRequest.headSha,
  headRef: pullRequest.headRef,
  headRepositoryFullName: pullRequest.headRepositoryFullName,
})

const sameTarget = (left: PullRequestRef, right: PullRequestRef) => {
  const a = targetOf(left)
  const b = targetOf(right)
  return (
    a.baseSha === b.baseSha &&
    a.baseRef === b.baseRef &&
    a.headSha === b.headSha &&
    a.headRef === b.headRef &&
    a.headRepositoryFullName === b.headRepositoryFullName
  )
}

const sameObservedState = (left: PullRequestRef, right: PullRequestRef) =>
  sameTarget(left, right) && left.draft === right.draft && left.state === right.state

const generationFor = (current: TrackedPullRequestState | undefined, pullRequest: PullRequestRef) =>
  Schema.decodeSync(GenerationNumber)(
    current === undefined
      ? 1
      : Number(current.generation) + (sameTarget(current.pullRequest, pullRequest) ? 0 : 1),
  )

const observationDisposition = (
  current: TrackedPullRequestState,
  observation: PullRequestObservation,
) => {
  const previous = current.pullRequest
  const observed = observation.pullRequest
  const previousTime = previous.updatedAt
  const observedTime = observed.updatedAt

  if (previousTime !== undefined && observedTime !== undefined && observedTime < previousTime) {
    return "stale" as const
  }

  const missingTimestamp = previousTime === undefined || observedTime === undefined
  const terminalRegression =
    (previous.state === "closed" &&
      observed.state === "open" &&
      observation.action !== "reopened") ||
    (previous.draft && !observed.draft && observation.action !== "ready_for_review")

  return (previousTime !== undefined &&
    observedTime !== undefined &&
    previousTime === observedTime &&
    !sameObservedState(previous, observed)) ||
    (missingTimestamp && !sameTarget(previous, observed)) ||
    terminalRegression ||
    (missingTimestamp &&
      ((previous.state === "closed" && observed.state === "open") ||
        (previous.draft && !observed.draft)))
    ? ("ambiguous" as const)
    : ("ordered" as const)
}

const isReviewable = (snapshot: PullRequestObservation | AuthoritativePullRequestSnapshot) =>
  snapshot.pullRequest.state === "open" &&
  !snapshot.pullRequest.draft &&
  (snapshot._tag === "AuthoritativePullRequestSnapshot" || reviewableActions.has(snapshot.action))

const nextReviewRequestNumber = (
  current: TrackedPullRequestState | undefined,
  snapshot: PullRequestObservation | AuthoritativePullRequestSnapshot,
  generation: GenerationNumber,
) => {
  if (!isReviewable(snapshot)) return null
  if (current === undefined || current.generation !== generation) {
    return Schema.decodeSync(ReviewRequestNumber)(1)
  }
  if (snapshot._tag === "PullRequest" && snapshot.action === "edited") {
    return null
  }

  const resumed =
    (snapshot._tag === "PullRequest" &&
      (snapshot.action === "reopened" || snapshot.action === "ready_for_review")) ||
    (snapshot._tag === "AuthoritativePullRequestSnapshot" &&
      ((current.pullRequest.state === "closed" && snapshot.pullRequest.state === "open") ||
        (current.pullRequest.draft && !snapshot.pullRequest.draft)))

  if (resumed && !current.reviewRequestActive) {
    return Schema.decodeSync(ReviewRequestNumber)(
      Number(current.latestReviewRequestNumber ?? 0) + 1,
    )
  }
  return current.latestReviewRequestNumber === undefined
    ? Schema.decodeSync(ReviewRequestNumber)(1)
    : null
}

export function decidePullRequestTransition(
  current: TrackedPullRequestState | undefined,
  snapshot: PullRequestObservation | AuthoritativePullRequestSnapshot,
): PullRequestTransitionDecision {
  if (current !== undefined && snapshot._tag === "PullRequest") {
    const disposition = observationDisposition(current, snapshot)
    if (disposition === "stale") {
      return PullRequestTransitionDecision.IgnoreObservation({
        generation: current.generation,
      })
    }
    if (disposition === "ambiguous") {
      return PullRequestTransitionDecision.RequestReconciliation({
        generation: current.generation,
      })
    }
  }

  const generation = generationFor(current, snapshot.pullRequest)
  const intents: Array<PullRequestTransitionIntent> = []
  if (current !== undefined && current.generation !== generation) {
    intents.push(PullRequestTransitionIntent.SupersedeGeneration({ generation }))
  }

  const reviewRequestNumber = nextReviewRequestNumber(current, snapshot, generation)
  if (reviewRequestNumber !== null) {
    intents.push(PullRequestTransitionIntent.QueueReview({ reviewRequestNumber }))
    if (
      current !== undefined &&
      current.generation === generation &&
      current.latestReviewRequestNumber !== undefined
    ) {
      intents.push(
        PullRequestTransitionIntent.SupersedeReviewRequests({
          generation,
          scope: "earlier-review-requests",
        }),
      )
    }
  } else if (snapshot.pullRequest.draft || snapshot.pullRequest.state !== "open") {
    intents.push(
      PullRequestTransitionIntent.SupersedeReviewRequests({
        generation,
        scope: "current-generation",
      }),
    )
  }

  return PullRequestTransitionDecision.ApplySnapshot({
    snapshot,
    generation,
    intents,
  })
}

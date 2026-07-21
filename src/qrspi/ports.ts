import { Context, Data, type Effect } from "effect"
import type { JsonValue } from "../json"
import type { RepositoryReference, TicketReference } from "./domain"

export class TicketSourceError extends Data.TaggedError("TicketSourceError")<{
  readonly cause: Error
}> {}

export class TicketSourceMalformedError extends Data.TaggedError("TicketSourceMalformedError")<{
  readonly cause: Error
}> {}

export class QrspiRepositoryError extends Data.TaggedError("QrspiRepositoryError")<{
  readonly operation: string
  readonly cause: Error
}> {}

export type TicketSourcePort = {
  readonly read: (
    reference: TicketReference,
  ) => Effect.Effect<JsonValue, TicketSourceError | TicketSourceMalformedError>
}
export const TicketSource = Context.GenericTag<TicketSourcePort>("workflowd/qrspi/TicketSource")

export type RepositoryInspection = {
  readonly repository: RepositoryReference
  readonly baseRef: string
  readonly baseSha: string
  readonly headRepository: RepositoryReference
}

export type AcceptedBranchObservation =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Accepted"; readonly sha: string }
  | { readonly _tag: "UnknownHistory"; readonly sha: string }

export type FinalPullRequestIntent = {
  readonly repository: RepositoryReference
  readonly baseRef: string
  readonly headRef: string
  readonly headSha: string
  readonly title: string
  readonly body: string
  readonly bodySha256: string
  readonly draft: false
}

export type FinalPullRequestObservation = {
  readonly reference: { readonly repository: RepositoryReference; readonly number: number }
  readonly baseRef: string
  readonly headRef: string
  readonly headSha: string
  readonly draft: boolean
  readonly body: string
  readonly bodySha256: string
  readonly url: string
}

export type QrspiRepositoryPort = {
  readonly inspect: (input: {
    readonly repository: RepositoryReference
    readonly baseRef: string
  }) => Effect.Effect<RepositoryInspection, QrspiRepositoryError>
  readonly hasOpenPullRequest: (input: {
    readonly repository: RepositoryReference
    readonly headRef: string
  }) => Effect.Effect<boolean, QrspiRepositoryError>
  readonly observeBranch: (input: {
    readonly repository: RepositoryReference
    readonly headRef: string
  }) => Effect.Effect<{ readonly sha: string } | null, QrspiRepositoryError>
  readonly observeAcceptedBranch: (input: {
    readonly repository: RepositoryReference
    readonly headRef: string
    readonly baseSha: string
    readonly previousTrustedSha: string | null
  }) => Effect.Effect<AcceptedBranchObservation, QrspiRepositoryError>
  readonly createBranch: (input: {
    readonly repository: RepositoryReference
    readonly headRef: string
    readonly expectedBaseSha: string
    readonly authority: {
      readonly operationId: string
      readonly leaseToken: string
      readonly leaseUntil: Date
    }
  }) => Effect.Effect<{ readonly sha: string }, QrspiRepositoryError | Error>
  readonly createFinalPullRequest: (
    input: FinalPullRequestIntent,
  ) => Effect.Effect<FinalPullRequestObservation["reference"], QrspiRepositoryError>
  readonly observeFinalPullRequest: (
    input: FinalPullRequestIntent,
  ) => Effect.Effect<FinalPullRequestObservation | null, QrspiRepositoryError>
}
export const QrspiRepository = Context.GenericTag<QrspiRepositoryPort>(
  "workflowd/qrspi/QrspiRepository",
)

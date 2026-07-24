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

export type QrspiRepositoryPort = {
  readonly readArtifact: (input: {
    readonly repository: RepositoryReference
    readonly commitSha: string
    readonly path: string
    readonly maxBytes: number
  }) => Effect.Effect<
    {
      readonly commitSha: string
      readonly path: string
      readonly blobSha: string
      readonly bytes: Uint8Array
    },
    QrspiRepositoryError
  >
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
}
export const QrspiRepository = Context.GenericTag<QrspiRepositoryPort>(
  "workflowd/qrspi/QrspiRepository",
)

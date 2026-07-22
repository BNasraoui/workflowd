import { randomUUID } from "node:crypto"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Exit, Layer, Schema } from "effect"
import {
  RepositoryReference,
  Ticket,
  TicketReference,
  WorkflowStartRequest,
  canonicalSha256,
  checkTicket,
  normalizeWorkflowDefinition,
  workflowDefinitionSha256,
  workflowIdFor,
  type TicketCheck,
  type TicketReadinessJudgment,
  type SourceResolver,
  type WorkflowDefinition,
  type WorkflowStartOutput,
} from "./domain"
import {
  QrspiRepository,
  TicketSource,
  type AcceptedBranchObservation,
  type QrspiRepositoryError,
  type TicketSourceError,
} from "./ports"
import { QrspiStore, type QrspiStoreDataError, type StartRecord } from "./store"

export class WorkflowStartUnauthorized extends Data.TaggedError("WorkflowStartUnauthorized")<{
  readonly reason: string
}> {}
export class TicketReadError extends Data.TaggedError("TicketReadError")<{
  readonly reason: string
}> {}
export class WorkflowStartConflict extends Data.TaggedError("WorkflowStartConflict")<{
  readonly reason: string
}> {}
export class WorkflowStartSuperseded extends Data.TaggedError("WorkflowStartSuperseded")<{
  readonly reason: string
}> {}
export class WorkflowStartBusy extends Data.TaggedError("WorkflowStartBusy")<{
  readonly reason: string
}> {}
export class WorkflowStartUncertain extends Data.TaggedError("WorkflowStartUncertain")<{
  readonly reason: string
}> {}
export class WorkflowStartNeedsOperator extends Data.TaggedError("WorkflowStartNeedsOperator")<{
  readonly reason: string
}> {}
export class WorkflowStartRetryExhausted extends Data.TaggedError("WorkflowStartRetryExhausted")<{
  readonly reason: string
}> {}

export type WorkflowStartOptions = {
  readonly binding: {
    readonly repository: typeof RepositoryReference.Type
    readonly trackerInstanceId: string
  }
  readonly baseRef: string
  readonly workflowDefinition: WorkflowDefinition
  readonly repositoryOperationTimeoutMs: number
  readonly operationCompletionMarginMs: number
  readonly leaseDurationMs: number
  readonly sourceResolver: SourceResolver
  readonly now?: () => Date
  readonly randomId?: () => string
}

export type WorkflowStartResult =
  WorkflowStartOutput | Extract<TicketCheck, { readonly _tag: "NeedsWork" }>

export type WorkflowStartError =
  | WorkflowStartUnauthorized
  | TicketReadError
  | WorkflowStartConflict
  | WorkflowStartSuperseded
  | WorkflowStartBusy
  | WorkflowStartUncertain
  | WorkflowStartNeedsOperator
  | WorkflowStartRetryExhausted
  | TicketSourceError
  | QrspiRepositoryError
  | QrspiStoreDataError
  | SqlError

export type WorkflowStartPort = {
  readonly start: (input: unknown) => Effect.Effect<WorkflowStartResult, WorkflowStartError>
}
export const WorkflowStart = Context.GenericTag<WorkflowStartPort>("workflowd/qrspi/WorkflowStart")

export const WorkflowStartLive = (options: WorkflowStartOptions) =>
  Layer.effect(
    WorkflowStart,
    Effect.gen(function* () {
      const tickets = yield* TicketSource
      const repositories = yield* QrspiRepository
      const store = yield* QrspiStore
      return WorkflowStart.of({
        start: (input) =>
          makeWorkflowStart(options)(input).pipe(
            Effect.provideService(TicketSource, tickets),
            Effect.provideService(QrspiRepository, repositories),
            Effect.provideService(QrspiStore, store),
          ),
      })
    }),
  )

export function makeWorkflowStart(options: WorkflowStartOptions) {
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? randomUUID
  if (
    options.leaseDurationMs <=
    options.repositoryOperationTimeoutMs + options.operationCompletionMarginMs
  ) {
    throw new Error("WorkflowStart lease must exceed repository timeout plus completion margin")
  }
  const workflowDefinition = normalizeWorkflowDefinition(options.workflowDefinition)
  const definitionSha256 = workflowDefinitionSha256(workflowDefinition)

  return (unknownRequest: unknown) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknown(WorkflowStartRequest)(unknownRequest).pipe(
        Effect.mapError(
          () => new WorkflowStartUnauthorized({ reason: "Malformed or ambiguous identity" }),
        ),
      )
      if (!sameRepository(request.repository, options.binding.repository)) {
        return yield* Effect.fail(
          new WorkflowStartUnauthorized({ reason: "Repository is not authorized" }),
        )
      }
      if (request.ticket.trackerInstanceId !== options.binding.trackerInstanceId) {
        return yield* Effect.fail(
          new WorkflowStartUnauthorized({ reason: "Ticket belongs to another Beads workspace" }),
        )
      }

      const tickets = yield* TicketSource
      const repositories = yield* QrspiRepository
      const store = yield* QrspiStore
      const ticket = yield* readTicket(tickets, request.ticket)
      const checked = checkTicket(ticket, now(), request.readinessJudgment, options.sourceResolver)
      if (checked._tag === "NeedsWork") return checked

      const workflowId = workflowIdFor(request.repository, request.ticket)
      const proposedBranchName = branchName(
        ticket.issueType,
        ticket.reference,
        checked.readyTicket.title,
      )
      const inspection = yield* repositories.inspect({
        repository: request.repository,
        baseRef: options.baseRef,
      })
      if (
        !sameRepository(inspection.repository, request.repository) ||
        !sameRepository(inspection.headRepository, request.repository) ||
        inspection.baseRef !== options.baseRef
      ) {
        return yield* Effect.fail(
          new WorkflowStartUnauthorized({ reason: "Ambiguous repository or fork target" }),
        )
      }
      const authorizedRequest = { ...request, repository: inspection.repository }
      const currentCursor = yield* store.getCurrentCursor(workflowId)
      if (currentCursor?.state === "reconciling") {
        return yield* Effect.fail(
          new WorkflowStartConflict({ reason: "Target reconciliation is still active" }),
        )
      }
      if (
        currentCursor !== null &&
        (currentCursor.baseRef !== inspection.baseRef ||
          currentCursor.baseSha !== inspection.baseSha)
      ) {
        return yield* Effect.fail(
          new WorkflowStartConflict({ reason: "Base target requires reconciliation" }),
        )
      }
      const selectedBranchName = yield* store.resolveBranch(workflowId, proposedBranchName, now())
      const input = {
        contractVersion: 1 as const,
        repository: authorizedRequest.repository,
        ticket: request.ticket,
        ticketRevisionSha256: checked.ticketRevision.ticketRevisionSha256,
        workflowDefinitionSha256: definitionSha256,
        baseRef: inspection.baseRef,
        baseSha: inspection.baseSha,
        branchName: selectedBranchName,
      }
      const requestedLeaseToken = randomId()
      let operation = yield* store.prepareStart({
        workflowId,
        proposedBranchName: selectedBranchName,
        ticketRevision: checked.ticketRevision,
        workflowDefinition,
        workflowDefinitionSha256: definitionSha256,
        inputSha256: canonicalSha256(input),
        inputJson: JSON.stringify(input),
        leaseToken: requestedLeaseToken,
        leaseDurationMs: options.leaseDurationMs,
        now: now(),
      })

      if (
        yield* repositories.hasOpenPullRequest({
          repository: authorizedRequest.repository,
          headRef: operation.branchName,
        })
      ) {
        if (
          operation.state === "blocked" ||
          operation.state === "ready" ||
          operation.state === "leased" ||
          operation.state === "waiting_external"
        ) {
          yield* store.failStart(
            operation.operationId,
            "ticket branch already has an open PR",
            "retryable",
            now(),
          )
        }
        return yield* Effect.fail(
          new WorkflowStartConflict({ reason: "Ticket branch already has an open pull request" }),
        )
      }

      const branchHistory = yield* repositories
        .observeAcceptedBranch({
          repository: authorizedRequest.repository,
          headRef: operation.branchName,
          baseSha: inspection.baseSha,
          previousTrustedSha: currentCursor?.currentHeadSha ?? null,
        })
        .pipe(
          Effect.catchAll(
            (
              error,
            ): Effect.Effect<
              AcceptedBranchObservation,
              QrspiRepositoryError | SqlError | WorkflowStartNeedsOperator
            > =>
              isExpiredFinalAttempt(operation, now())
                ? store
                    .recoverExpiredLease(
                      operation.operationId,
                      "unknown",
                      JSON.stringify({ headRef: operation.branchName, outcome: "unknown" }),
                      now(),
                    )
                    .pipe(
                      Effect.flatMap(() =>
                        Effect.fail(
                          new WorkflowStartNeedsOperator({
                            reason: "Final-attempt branch observation is unknown",
                          }),
                        ),
                      ),
                    )
                : Effect.fail(error),
          ),
        )
      if (branchHistory._tag === "UnknownHistory") {
        if (currentCursor !== null) {
          if (operation.state !== "succeeded") {
            yield* store.failStart(
              operation.operationId,
              "branch history is not trusted",
              "operator_required",
              now(),
            )
          }
        } else if (operation.state !== "succeeded") {
          yield* store.waitStartForOperator(
            operation.operationId,
            "branch history is not trusted",
            now(),
          )
        }
        return yield* Effect.fail(
          new WorkflowStartConflict({
            reason: "Branch history after the trusted cursor is unknown",
          }),
        )
      }
      let observed = branchHistory._tag === "Accepted" ? { sha: branchHistory.sha } : null

      if (isExpiredFinalAttempt(operation, now())) {
        const recovered = yield* store.recoverExpiredLease(
          operation.operationId,
          observed === null ? "absent" : "present",
          JSON.stringify(
            observed === null
              ? { headRef: operation.branchName, present: false }
              : { headRef: operation.branchName, sha: observed.sha },
          ),
          now(),
          observed === null
            ? undefined
            : JSON.stringify({
                idempotencyIdentity: operation.logicalOperationId,
                repository: authorizedRequest.repository,
                headRef: operation.branchName,
                expectedSha: observed.sha,
              }),
        )
        if (recovered === "failed") {
          return yield* Effect.fail(
            new WorkflowStartRetryExhausted({ reason: "Final-attempt branch effect is absent" }),
          )
        }
        if (recovered === "waiting_human") {
          return yield* Effect.fail(
            new WorkflowStartNeedsOperator({ reason: "Final-attempt branch outcome is unknown" }),
          )
        }
        if (recovered === "stale") return yield* busy()
        operation = yield* store.prepareStart({
          workflowId,
          proposedBranchName: selectedBranchName,
          ticketRevision: checked.ticketRevision,
          workflowDefinition,
          workflowDefinitionSha256: definitionSha256,
          inputSha256: canonicalSha256(input),
          inputJson: JSON.stringify(input),
          leaseToken: requestedLeaseToken,
          leaseDurationMs: options.leaseDurationMs,
          now: now(),
        })
      }

      if (
        operation.state === "failed" ||
        operation.state === "cancelled" ||
        operation.state === "data_error"
      ) {
        if (operation.terminalRetryPolicy === "operator_required") {
          return yield* Effect.fail(
            new WorkflowStartNeedsOperator({ reason: "WorkflowStart requires an operator" }),
          )
        }
        return yield* Effect.fail(
          new WorkflowStartRetryExhausted({
            reason: "Terminal WorkflowStart requires explicit operator replacement",
          }),
        )
      }
      if (operation.state === "waiting_human") {
        return yield* Effect.fail(
          new WorkflowStartNeedsOperator({ reason: "WorkflowStart is waiting for an operator" }),
        )
      }

      if (operation.state === "succeeded") {
        if (
          observed === null ||
          operation.output === undefined ||
          observed.sha !== operation.output.rootSha
        ) {
          return yield* Effect.fail(
            new WorkflowStartConflict({
              reason: "Succeeded WorkflowStart effect is no longer present",
            }),
          )
        }
        yield* finalRecheck({
          tickets,
          repositories,
          request,
          checked,
          inspection,
          branchName: operation.branchName,
          workflowDefinitionSha256: definitionSha256,
          workflowDefinition,
          previousTrustedSha: currentCursor?.currentHeadSha ?? null,
          expectedRootSha: operation.output.rootSha,
          readinessJudgment: request.readinessJudgment,
          sourceResolver: options.sourceResolver,
          now,
        })
        if (!(yield* store.isStartCurrent(operation.operationId, operation.inputSha256))) {
          return yield* Effect.fail(
            new WorkflowStartSuperseded({ reason: "Succeeded WorkflowStart lost currentness" }),
          )
        }
        return operation.output
      }

      if (operation.state === "waiting_external") {
        if (observed === null) {
          const ready = yield* store.recordBranchAbsent(
            operation.operationId,
            JSON.stringify({ headRef: operation.branchName, present: false }),
            now(),
          )
          if (ready === "stale") return yield* busy()
          if (ready === "waiting_human") {
            return yield* Effect.fail(
              new WorkflowStartNeedsOperator({
                reason: "External observation budget exhausted",
              }),
            )
          }
          operation = yield* claimOperation(
            store,
            operation.operationId,
            randomId(),
            options.leaseDurationMs,
            now(),
          )
        }
      } else if (operation.state === "ready") {
        operation = yield* claimOperation(
          store,
          operation.operationId,
          requestedLeaseToken,
          options.leaseDurationMs,
          now(),
        )
      } else if (
        operation.state === "leased" &&
        !ownsLease(operation, requestedLeaseToken, now())
      ) {
        if (
          operation.leaseUntil !== undefined &&
          operation.leaseUntil.getTime() > now().getTime()
        ) {
          return yield* busy()
        }
        operation = yield* claimOperation(
          store,
          operation.operationId,
          randomId(),
          options.leaseDurationMs,
          now(),
        )
      }

      if (observed === null) {
        const authority = yield* leaseAuthority(operation, now())
        const intent = {
          idempotencyIdentity: operation.logicalOperationId,
          repository: authorizedRequest.repository,
          headRef: operation.branchName,
          expectedAbsent: true,
          expectedBaseSha: inspection.baseSha,
        }
        const recorded = yield* store.recordBranchIntent(
          operation.operationId,
          authority.leaseToken,
          JSON.stringify(intent),
          now(),
        )
        if (recorded === "stale") return yield* busy()
        if (!(yield* store.validateLease(operation.operationId, authority.leaseToken, now()))) {
          return yield* busy()
        }
        yield* Effect.uninterruptibleMask((restore) =>
          restore(
            repositories
              .createBranch({
                repository: authorizedRequest.repository,
                headRef: operation.branchName,
                expectedBaseSha: inspection.baseSha,
                authority,
              })
              .pipe(
                Effect.timeout(options.repositoryOperationTimeoutMs),
                Effect.mapError(
                  () =>
                    new WorkflowStartUncertain({
                      reason: "Repository branch create outcome is unknown",
                    }),
                ),
              ),
          ).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isSuccess(exit)
                ? Effect.succeed(exit.value)
                : store
                    .recordUnknownOutcome(
                      operation.operationId,
                      authority.leaseToken,
                      JSON.stringify({ headRef: operation.branchName, outcome: "unknown" }),
                      now(),
                    )
                    .pipe(
                      Effect.flatMap(
                        (
                          recorded,
                        ): Effect.Effect<
                          never,
                          WorkflowStartSuperseded | WorkflowStartUncertain
                        > =>
                          recorded === "stale"
                            ? Effect.fail(
                                new WorkflowStartSuperseded({
                                  reason: "WorkflowStart lost currentness after external effect",
                                }),
                              )
                            : Effect.failCause(exit.cause),
                      ),
                    ),
            ),
          ),
        )
        const waiting = yield* store.markWaitingExternal(
          operation.operationId,
          authority.leaseToken,
          JSON.stringify({ headRef: operation.branchName, mutationAttempted: true }),
          now(),
        )
        if (waiting === "stale") return yield* busy()
        const createdHistory = yield* repositories.observeAcceptedBranch({
          repository: authorizedRequest.repository,
          headRef: operation.branchName,
          baseSha: inspection.baseSha,
          previousTrustedSha: currentCursor?.currentHeadSha ?? null,
        })
        if (createdHistory._tag !== "Accepted") {
          return yield* Effect.fail(
            new WorkflowStartConflict({
              reason: "Authoritative branch observation did not confirm intended creation",
            }),
          )
        }
        observed = { sha: createdHistory.sha }
      } else if (operation.state === "leased") {
        const authority = yield* leaseAuthority(operation, now())
        const recorded = yield* store.recordBranchIntent(
          operation.operationId,
          authority.leaseToken,
          JSON.stringify({
            idempotencyIdentity: operation.logicalOperationId,
            repository: authorizedRequest.repository,
            headRef: operation.branchName,
            expectedSha: observed.sha,
          }),
          now(),
        )
        if (recorded === "stale") return yield* busy()
        const waiting = yield* store.markWaitingExternal(
          operation.operationId,
          authority.leaseToken,
          JSON.stringify({ headRef: operation.branchName, sha: observed.sha }),
          now(),
        )
        if (waiting === "stale") return yield* busy()
      }

      if (observed === null) {
        return yield* Effect.fail(
          new WorkflowStartConflict({
            reason: "Authoritative branch observation did not match intent",
          }),
        )
      }

      yield* finalRecheck({
        tickets,
        repositories,
        request: authorizedRequest,
        checked,
        inspection,
        branchName: operation.branchName,
        workflowDefinitionSha256: definitionSha256,
        workflowDefinition,
        previousTrustedSha: currentCursor?.currentHeadSha ?? null,
        expectedRootSha: observed.sha,
        readinessJudgment: request.readinessJudgment,
        sourceResolver: options.sourceResolver,
        now,
        onChanged: () =>
          store.supersedeStart(operation.operationId, "authoritative input changed", now()),
      })

      return yield* store
        .completeStart({
          operationId: operation.operationId,
          workflowId,
          branchName: operation.branchName,
          ticketRevisionSha256: checked.ticketRevision.ticketRevisionSha256,
          workflowDefinitionSha256: definitionSha256,
          repositoryJson: JSON.stringify(authorizedRequest.repository),
          baseRef: inspection.baseRef,
          baseSha: inspection.baseSha,
          rootSha: observed.sha,
          authoritativeObservation: { headRef: operation.branchName, sha: observed.sha },
          now: now(),
        })
        .pipe(
          Effect.catchTag("WorkflowStartCurrentnessError", (error) =>
            Effect.fail(new WorkflowStartSuperseded({ reason: error.reason })),
          ),
        )
    }).pipe(
      Effect.catchTag("WorkflowStartRetryExhaustedError", () =>
        Effect.fail(new WorkflowStartRetryExhausted({ reason: "Retry budget exhausted" })),
      ),
      Effect.catchTag("WorkflowStartCurrentnessError", (error) =>
        Effect.fail(new WorkflowStartSuperseded({ reason: error.reason })),
      ),
    )
}

function finalRecheck(input: {
  readonly tickets: typeof TicketSource.Service
  readonly repositories: typeof QrspiRepository.Service
  readonly request: typeof WorkflowStartRequest.Type
  readonly checked: Extract<TicketCheck, { readonly _tag: "Ready" }>
  readonly inspection: {
    readonly repository: typeof RepositoryReference.Type
    readonly headRepository: typeof RepositoryReference.Type
    readonly baseRef: string
    readonly baseSha: string
  }
  readonly branchName: string
  readonly workflowDefinitionSha256: string
  readonly workflowDefinition: WorkflowDefinition
  readonly previousTrustedSha: string | null
  readonly expectedRootSha: string
  readonly readinessJudgment: TicketReadinessJudgment
  readonly sourceResolver: SourceResolver
  readonly now: () => Date
  readonly onChanged?: () => Effect.Effect<void, SqlError>
}) {
  return Effect.gen(function* () {
    const finalTicket = yield* readTicket(input.tickets, input.request.ticket)
    const finalCheck = checkTicket(
      finalTicket,
      input.now(),
      input.readinessJudgment,
      input.sourceResolver,
    )
    const finalInspection = yield* input.repositories.inspect({
      repository: input.request.repository,
      baseRef: input.inspection.baseRef,
    })
    const finalBranch = yield* input.repositories.observeAcceptedBranch({
      repository: input.request.repository,
      headRef: input.branchName,
      baseSha: input.inspection.baseSha,
      previousTrustedSha: input.previousTrustedSha,
    })
    const finalOpenPr = yield* input.repositories.hasOpenPullRequest({
      repository: input.request.repository,
      headRef: input.branchName,
    })
    if (
      finalCheck._tag !== "Ready" ||
      finalCheck.ticketRevision.ticketRevisionSha256 !==
        input.checked.ticketRevision.ticketRevisionSha256 ||
      !sameRepository(finalInspection.repository, input.inspection.repository) ||
      !sameRepository(finalInspection.headRepository, input.inspection.headRepository) ||
      finalInspection.baseRef !== input.inspection.baseRef ||
      finalInspection.baseSha !== input.inspection.baseSha ||
      finalBranch._tag !== "Accepted" ||
      (finalBranch._tag === "Accepted" && finalBranch.sha !== input.expectedRootSha) ||
      finalOpenPr ||
      input.workflowDefinitionSha256 !== workflowDefinitionSha256(input.workflowDefinition)
    ) {
      if (input.onChanged !== undefined) yield* input.onChanged()
      return yield* Effect.fail(
        new WorkflowStartSuperseded({ reason: "Ticket, definition, base, or branch changed" }),
      )
    }
  })
}

function readTicket(tickets: typeof TicketSource.Service, reference: typeof TicketReference.Type) {
  return tickets.read(reference).pipe(
    Effect.catchTag("TicketSourceMalformedError", () =>
      Effect.fail(new TicketReadError({ reason: "Beads ticket could not be decoded" })),
    ),
    Effect.flatMap((value) =>
      Schema.decodeUnknown(Ticket)(value).pipe(
        Effect.mapError(() => new TicketReadError({ reason: "Beads ticket could not be decoded" })),
      ),
    ),
    Effect.filterOrFail(
      (ticket) => sameTicket(ticket.reference, reference),
      () => new TicketReadError({ reason: "Beads returned a different ticket identity" }),
    ),
  )
}

function ownsLease(operation: StartRecord, leaseToken: string, now: Date) {
  return (
    operation.leaseToken === leaseToken &&
    operation.leaseUntil !== undefined &&
    operation.leaseUntil.getTime() > now.getTime()
  )
}

function isExpiredFinalAttempt(operation: StartRecord, now: Date) {
  return (
    operation.state === "leased" &&
    operation.attempt >= operation.maxAttempts &&
    operation.leaseUntil !== undefined &&
    operation.leaseUntil.getTime() <= now.getTime()
  )
}

function leaseAuthority(operation: StartRecord, now: Date) {
  if (
    operation.state !== "leased" ||
    operation.leaseToken === undefined ||
    operation.leaseUntil === undefined ||
    operation.leaseUntil.getTime() <= now.getTime()
  ) {
    return Effect.fail(
      new WorkflowStartBusy({ reason: "WorkflowStart has no unexpired lease authority" }),
    )
  }
  return Effect.succeed({
    operationId: operation.operationId,
    leaseToken: operation.leaseToken,
    leaseUntil: operation.leaseUntil,
  })
}

function busy() {
  return Effect.fail(new WorkflowStartBusy({ reason: "WorkflowStart is leased by another caller" }))
}

function claimOperation(
  store: typeof QrspiStore.Service,
  operationId: string,
  leaseToken: string,
  leaseDurationMs: number,
  now: Date,
) {
  return store.claimStart(operationId, leaseToken, leaseDurationMs, now).pipe(
    Effect.catchTag("WorkflowStartRetryExhaustedError", () =>
      Effect.fail(new WorkflowStartRetryExhausted({ reason: "Retry budget exhausted" })),
    ),
    Effect.catchTag("WorkflowStartCurrentnessError", () =>
      Effect.fail(new WorkflowStartBusy({ reason: "WorkflowStart is not claimable" })),
    ),
  )
}

function sameRepository(
  left: typeof RepositoryReference.Type,
  right: typeof RepositoryReference.Type,
) {
  return (
    left.providerInstanceId === right.providerInstanceId && left.repositoryId === right.repositoryId
  )
}

function sameTicket(left: typeof TicketReference.Type, right: typeof TicketReference.Type) {
  return (
    left.tracker === right.tracker &&
    left.trackerInstanceId === right.trackerInstanceId &&
    left.nativeTicketId === right.nativeTicketId
  )
}

function branchName(issueType: string, ticket: typeof TicketReference.Type, title: string) {
  const safeType = issueType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const safeTicket = ticket.nativeTicketId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[-.]|[-.]$/g, "")
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-$/g, "")
  return `${safeType}/${safeTicket}-${slug}`
}

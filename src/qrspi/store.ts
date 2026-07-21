import { SqlClient } from "@effect/sql"
import { createHash } from "node:crypto"
import type { SqlError } from "@effect/sql/SqlError"
import type { ParseError } from "effect/ParseResult"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { runStoreMigrations } from "../store/migrations"
import {
  RepositoryReference,
  ReadyTicket,
  WorkflowDefinition,
  WorkflowStartInput,
  WorkflowStartOutput,
  canonicalSha256,
  stageDefinitionSha256,
  workflowDefinitionSha256,
  type StageDefinition,
  type TicketRevision,
} from "./domain"
import {
  ArtifactReference,
  ImplementationCheckpointReference,
  ImplementationCommitReference,
  ImplementationStageResult,
  PreparedDeliveryEvidence,
  validatePreparedDeliveryEvidence,
} from "./stages"
import type { BoundArtifactPublication } from "./artifact-publication"
import type { AgentLaunchIntent, SessionReference } from "../agent-harness"
import type { FinalPullRequestIntent, FinalPullRequestObservation } from "./ports"

const OperationState = Schema.Literal(
  "blocked",
  "ready",
  "leased",
  "waiting_external",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
  "data_error",
)

const StartRecord = Schema.Struct({
  operationId: Schema.NonEmptyString,
  logicalOperationId: Schema.NonEmptyString,
  operationRevision: Schema.Int.pipe(Schema.positive()),
  state: OperationState,
  attempt: Schema.Int.pipe(Schema.nonNegative()),
  maxAttempts: Schema.Int.pipe(Schema.positive()),
  leaseToken: Schema.optional(Schema.NonEmptyString),
  leaseUntil: Schema.optional(Schema.DateFromSelf),
  inputSha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  branchName: Schema.NonEmptyString,
  output: Schema.optional(WorkflowStartOutput),
  terminalRetryPolicy: Schema.optional(
    Schema.Literal(
      "retryable",
      "retry_budget_exhausted",
      "operator_required",
      "cancelled",
      "data_error",
    ),
  ),
})
export type StartRecord = typeof StartRecord.Type

const OperationRow = Schema.Struct({
  operation_id: Schema.NonEmptyString,
  logical_operation_id: Schema.NonEmptyString,
  operation_revision: Schema.Int.pipe(Schema.positive()),
  retry_of: Schema.NullOr(Schema.String),
  kind: Schema.String,
  scope_json: Schema.String,
  input_json: Schema.String,
  input_sha256: Schema.String,
  output_json: Schema.NullOr(Schema.String),
  state: OperationState,
  is_current: Schema.Literal(0, 1),
  attempt: Schema.Int.pipe(Schema.nonNegative()),
  max_attempts: Schema.Int.pipe(Schema.positive()),
  lease_owner: Schema.NullOr(Schema.String),
  lease_token: Schema.NullOr(Schema.String),
  lease_until: Schema.NullOr(Schema.String),
  run_at: Schema.String,
  external_intent_json: Schema.NullOr(Schema.String),
  external_observation_json: Schema.NullOr(Schema.String),
  observation_attempts: Schema.Int.pipe(Schema.nonNegative()),
  max_observation_attempts: Schema.Int.pipe(Schema.positive()),
  parent_effect_json: Schema.String,
  last_error: Schema.NullOr(Schema.String),
  terminal_failure_reason: Schema.NullOr(Schema.String),
  terminal_retry_policy: Schema.NullOr(
    Schema.Literal(
      "retryable",
      "retry_budget_exhausted",
      "operator_required",
      "cancelled",
      "data_error",
    ),
  ),
  created_at: Schema.String,
  updated_at: Schema.String,
})
type OperationRow = typeof OperationRow.Type

const JsonObjectText = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
)
const WorkflowScope = Schema.Struct({
  _tag: Schema.Literal("WorkflowScope"),
  workflowId: Schema.NonEmptyString,
})
const decodeOutput = Schema.decodeUnknown(Schema.parseJson(WorkflowStartOutput))

export type PrepareStartInput = {
  readonly workflowId: string
  readonly proposedBranchName: string
  readonly ticketRevision: TicketRevision
  readonly workflowDefinition: WorkflowDefinition
  readonly workflowDefinitionSha256: string
  readonly inputSha256: string
  readonly inputJson: string
  readonly leaseToken: string
  readonly leaseDurationMs: number
  readonly now: Date
}

export type CompleteStartInput = {
  readonly operationId: string
  readonly workflowId: string
  readonly branchName: string
  readonly ticketRevisionSha256: string
  readonly workflowDefinitionSha256: string
  readonly repositoryJson: string
  readonly baseRef: string
  readonly baseSha: string
  readonly rootSha: string
  readonly authoritativeObservation: {
    readonly headRef: string
    readonly sha: string
  }
  readonly now: Date
}

export type WorkflowStartTerminalRetryPolicy = "retryable" | "operator_required"

type StoreError =
  SqlError | QrspiStoreDataError | WorkflowStartCurrentnessError | WorkflowStartRetryExhaustedError

export type QrspiStorePort = {
  readonly getActiveWorkflowDefinitions: () => Effect.Effect<
    ReadonlyArray<WorkflowDefinition>,
    SqlError | ParseError | Error
  >
  readonly getCurrentCursor: (workflowId: string) => Effect.Effect<
    {
      readonly generation: number
      readonly currentHeadSha: string
      readonly headRef: string
      readonly baseRef: string
      readonly baseSha: string
      readonly state: string
    } | null,
    SqlError
  >
  readonly resolveBranch: (
    workflowId: string,
    proposedBranchName: string,
    now: Date,
  ) => Effect.Effect<string, SqlError>
  readonly prepareStart: (input: PrepareStartInput) => Effect.Effect<StartRecord, StoreError>
  readonly claimStart: (
    operationId: string,
    leaseToken: string,
    leaseDurationMs: number,
    now: Date,
  ) => Effect.Effect<StartRecord, StoreError>
  readonly recordBranchIntent: (
    operationId: string,
    leaseToken: string,
    intentJson: string,
    now: Date,
  ) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly validateLease: (
    operationId: string,
    leaseToken: string,
    now: Date,
  ) => Effect.Effect<boolean, SqlError>
  readonly isStartCurrent: (
    operationId: string,
    inputSha256: string,
  ) => Effect.Effect<boolean, SqlError>
  readonly markWaitingExternal: (
    operationId: string,
    leaseToken: string,
    observationJson: string,
    now: Date,
  ) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly recordUnknownOutcome: (
    operationId: string,
    leaseToken: string,
    observationJson: string,
    now: Date,
  ) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly recoverExpiredLease: (
    operationId: string,
    outcome: "present" | "absent" | "unknown",
    observationJson: string,
    now: Date,
    intentJson?: string,
  ) => Effect.Effect<"waiting_external" | "failed" | "waiting_human" | "stale", SqlError>
  readonly recordBranchAbsent: (
    operationId: string,
    observationJson: string,
    now: Date,
  ) => Effect.Effect<"ready" | "waiting_human" | "stale", SqlError>
  readonly supersedeStart: (
    operationId: string,
    reason: string,
    now: Date,
  ) => Effect.Effect<void, SqlError>
  readonly failStart: (
    operationId: string,
    reason: string,
    retryPolicy: WorkflowStartTerminalRetryPolicy,
    now: Date,
  ) => Effect.Effect<void, SqlError>
  readonly waitStartForOperator: (
    operationId: string,
    reason: string,
    now: Date,
  ) => Effect.Effect<void, SqlError>
  readonly completeStart: (
    input: CompleteStartInput,
  ) => Effect.Effect<WorkflowStartOutput, StoreError>
  readonly claimStageOperation: (
    kind: "StageProduce" | "ArtifactPublish",
    workerId: string,
    leaseToken: string,
    leaseDurationMs: number,
    now: Date,
  ) => Effect.Effect<StageOperationLease | null, SqlError | ParseError | Error>
  readonly findArtifactPublicationRecovery: () => Effect.Effect<
    | (
        | (StageOperationLease & { readonly bound: BoundArtifactPublication })
        | (StageOperationLease & {
            readonly implementationCommit: typeof ImplementationCommitReference.Type
          })
      )
    | null,
    SqlError | ParseError | Error
  >
  readonly isStageOperationCurrent: (
    operationId: string,
    leaseToken: string,
    now: Date,
  ) => Effect.Effect<boolean, SqlError>
  readonly isTrustedArtifactPublication: (input: {
    readonly repository: typeof RepositoryReference.Type
    readonly headRef: string
    readonly controllerId: string
    readonly operationId: string
    readonly commitSha: string
  }) => Effect.Effect<string | null, SqlError>
  readonly recordStageAgentLaunchIntent: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly launchIntent: AgentLaunchIntent<unknown>
    readonly now: Date
  }) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly recordStageAgentSessionReference: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly reference: SessionReference
    readonly now: Date
  }) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly requireStageSessionCleanup: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly sessionReferenceId: string
    readonly error: string
    readonly now: Date
  }) => Effect.Effect<"waiting_human" | "stale", SqlError>
  readonly rescheduleStageOperation: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly error: string
    readonly runAt: Date
    readonly now: Date
    readonly confirmedAbortedSessionReferenceId?: string
  }) => Effect.Effect<"rescheduled" | "failed" | "stale", SqlError>
  readonly recordArtifactPublicationOutcome: (input: {
    readonly operationId: string
    readonly outcome: "conflict" | "uncertain"
    readonly observedHeadSha: string | null
    readonly now: Date
  }) => Effect.Effect<"waiting_external" | "waiting_human" | "stale", SqlError>
  readonly recordStaleArtifactPublicationEffect: (input: {
    readonly operationId: string
    readonly expectedOld: string
    readonly finalSha: string
    readonly observedHeadSha: string
    readonly now: Date
  }) => Effect.Effect<"reconciling" | "stale", SqlError | ParseError>
  readonly completeStageProduce: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly preparedResult: unknown
    readonly sessionReferenceId: string
    readonly now: Date
  }) => Effect.Effect<"completed" | "stale", SqlError | ParseError>
  readonly bindArtifactPublication: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly expectedOld: string
    readonly finalSha: string
    readonly artifact: typeof ArtifactReference.Type
    readonly now: Date
  }) => Effect.Effect<"bound" | "conflict" | "stale", SqlError | ParseError>
  readonly completeArtifactPublication: (input: {
    readonly operationId: string
    readonly expectedOld: string
    readonly finalSha: string
    readonly artifact: typeof ArtifactReference.Type
    readonly observedHeadSha: string
    readonly now: Date
  }) => Effect.Effect<"completed" | "stale", SqlError | ParseError | WorkflowStartCurrentnessError>
  readonly acceptStagePolicy: (input: {
    readonly workflowId: string
    readonly generation: number
    readonly stageKey: string
    readonly stageRevision: number
    readonly now: Date
  }) => Effect.Effect<"completed" | "stale", SqlError | ParseError>
  readonly requestDocumentRevision: (input: {
    readonly workflowId: string
    readonly generation: number
    readonly stageKey: string
    readonly stageRevision: number
    readonly acceptedSources: ReadonlyArray<typeof ArtifactReference.Type>
    readonly feedback?: ReadonlyArray<string>
    readonly now: Date
  }) => Effect.Effect<"completed" | "stale", SqlError | ParseError>
  readonly bindImplementationPublication: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly expectedOld: string
    readonly commit: typeof ImplementationCommitReference.Type
    readonly now: Date
  }) => Effect.Effect<"bound" | "conflict" | "stale", SqlError | ParseError>
  readonly completeImplementationPublication: (input: {
    readonly operationId: string
    readonly expectedOld: string
    readonly commit: typeof ImplementationCommitReference.Type
    readonly checkpoint?: typeof ImplementationCheckpointReference.Type
    readonly observedHeadSha: string
    readonly now: Date
  }) => Effect.Effect<"completed" | "stale", SqlError | ParseError | WorkflowStartCurrentnessError>
  readonly claimFinalizationOperation: (
    kind: "PrePullRequestVerify" | "PullRequestPublish",
    workerId: string,
    leaseToken: string,
    leaseDurationMs: number,
    now: Date,
  ) => Effect.Effect<FinalizationOperationLease | null, SqlError | ParseError>
  readonly findPullRequestPublicationRecovery: () => Effect.Effect<
    FinalizationOperationLease | null,
    SqlError | ParseError
  >
  readonly completePrePullRequestVerification: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly observedHeadSha: string
    readonly now: Date
  }) => Effect.Effect<"verified" | "stale", SqlError | ParseError>
  readonly bindPullRequestPublication: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly intent: FinalPullRequestIntent
    readonly now: Date
  }) => Effect.Effect<"bound" | "conflict" | "stale", SqlError | ParseError>
  readonly bindPullRequestPublicationReference: (input: {
    readonly operationId: string
    readonly reference: FinalPullRequestObservation["reference"]
    readonly now: Date
  }) => Effect.Effect<"bound" | "stale", SqlError | ParseError>
  readonly isFinalizationOperationCurrent: (
    operationId: string,
    now: Date,
  ) => Effect.Effect<boolean, SqlError>
  readonly completePullRequestPublication: (input: {
    readonly operationId: string
    readonly observation: FinalPullRequestObservation
    readonly now: Date
  }) => Effect.Effect<"published" | "stale", SqlError | ParseError>
  readonly recordStalePullRequestPublicationEffect: (input: {
    readonly operationId: string
    readonly intent: FinalPullRequestIntent
    readonly reference: FinalPullRequestObservation["reference"]
    readonly observation?: FinalPullRequestObservation
    readonly now: Date
  }) => Effect.Effect<"reconciling" | "stale", SqlError | ParseError>
  readonly rescheduleFinalizationOperation: (input: {
    readonly operationId: string
    readonly leaseToken: string
    readonly error: string
    readonly runAt: Date
    readonly now: Date
  }) => Effect.Effect<"rescheduled" | "failed" | "stale", SqlError | ParseError>
}

export type StageOperationLease = {
  readonly controllerId: string
  readonly operationId: string
  readonly operationRevision: number
  readonly attempt: number
  readonly leaseToken: string
  readonly scope: typeof GenerationScope.Type
  readonly input: typeof StageOperationInput.Type
  readonly stage: StageDefinition
  readonly repository: typeof RepositoryReference.Type
  readonly headRef: string
  readonly currentHeadSha: string
  readonly preparedResult?: unknown
  readonly ticketId: string
  readonly readyTicket: typeof ReadyTicket.Type
  readonly sessionReferenceId?: string
  readonly predecessorSessionReferenceId?: string
  readonly implementationCommits?: ReadonlyArray<typeof ImplementationCommitReference.Type>
}

export type FinalizationOperationLease = {
  readonly operationId: string
  readonly operationRevision: number
  readonly attempt: number
  readonly leaseToken?: string
  readonly scope: typeof GenerationScope.Type
  readonly kind: "PrePullRequestVerify" | "PullRequestPublish"
  readonly input: unknown
  readonly intent?: FinalPullRequestIntent
  readonly publicationReference?: FinalPullRequestObservation["reference"]
  readonly repository: typeof RepositoryReference.Type
  readonly baseRef: string
  readonly headRef: string
  readonly currentHeadSha: string
}

export const QrspiStore = Context.GenericTag<QrspiStorePort>("workflowd/qrspi/QrspiStore")

export class QrspiStoreDataError extends Data.TaggedError("QrspiStoreDataError")<{
  readonly record: "workflow_operation" | "workflow_definition"
  readonly recordId: string
  readonly message: string
}> {}

export class WorkflowStartCurrentnessError extends Data.TaggedError(
  "WorkflowStartCurrentnessError",
)<{ readonly operationId: string; readonly reason: string }> {}

export class WorkflowStartRetryExhaustedError extends Data.TaggedError(
  "WorkflowStartRetryExhaustedError",
)<{ readonly operationId: string }> {}

const dataError = (record: QrspiStoreDataError["record"], recordId: string, cause: unknown) =>
  new QrspiStoreDataError({ record, recordId, message: String(cause) })

function make(sql: SqlClient.SqlClient): QrspiStorePort {
  const transaction = <A, E>(effect: Effect.Effect<A, E>) => sql.withTransaction(effect)

  const selectOperation = (operationId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT * FROM workflow_operations WHERE operation_id = ${operationId}
      `
      if (rows[0] === undefined) {
        return yield* Effect.fail(
          new WorkflowStartCurrentnessError({ operationId, reason: "operation does not exist" }),
        )
      }
      return yield* decodeRow(rows[0])
    })

  const quarantine = (error: QrspiStoreDataError) =>
    error.record !== "workflow_operation"
      ? Effect.fail(error)
      : sql`
          UPDATE workflow_operations
          SET state = 'data_error', last_error = ${error.message}, lease_owner = NULL,
              lease_token = NULL, lease_until = NULL,
              terminal_failure_reason = ${error.message}, terminal_retry_policy = 'data_error',
              updated_at = ${new Date().toISOString()}
          WHERE operation_id = ${error.recordId}
        `.pipe(Effect.andThen(Effect.fail(error)))

  return {
    getActiveWorkflowDefinitions: () =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly definition_sha256: string
          readonly definition_json: string
        }>`
          SELECT DISTINCT d.definition_sha256, d.definition_json
          FROM qrspi_generations g
          JOIN qrspi_workflow_definitions d
            ON d.definition_sha256 = g.workflow_definition_sha256
          WHERE g.is_current = 1 AND g.state IN (
            'running', 'waiting_ticket', 'waiting_human', 'reconciling', 'finalizing'
          )
        `
        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(row.definition_json).pipe(
            Effect.filterOrFail(
              (definition) => workflowDefinitionSha256(definition) === row.definition_sha256,
              () =>
                new Error(`Retained workflow definition hash mismatch: ${row.definition_sha256}`),
            ),
          ),
        )
      }),
    getCurrentCursor: (workflowId) =>
      sql<{
        readonly generation: number
        readonly current_head_sha: string
        readonly head_ref: string
        readonly base_ref: string
        readonly base_sha: string
        readonly state: string
      }>`
        SELECT generation, current_head_sha, head_ref, base_ref, base_sha, state
        FROM qrspi_generations
        WHERE workflow_id = ${workflowId} AND is_current = 1
      `.pipe(
        Effect.map((rows) => {
          const row = rows[0]
          return row === undefined
            ? null
            : {
                generation: Number(row.generation),
                currentHeadSha: row.current_head_sha,
                headRef: row.head_ref,
                baseRef: row.base_ref,
                baseSha: row.base_sha,
                state: row.state,
              }
        }),
      ),
    resolveBranch: (workflowId, proposedBranchName, now) =>
      transaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
            VALUES (${workflowId}, ${proposedBranchName}, ${now.toISOString()}, ${now.toISOString()})
            ON CONFLICT (workflow_id) DO NOTHING
          `
          const rows = yield* sql<{ readonly branch_name: string }>`
            SELECT branch_name FROM qrspi_workflows WHERE workflow_id = ${workflowId}
          `
          return rows[0]?.branch_name ?? proposedBranchName
        }),
      ),

    prepareStart: (input) => {
      const operation = transaction(
        Effect.gen(function* () {
          const now = input.now.toISOString()
          const workflowRows = yield* sql<{ readonly branch_name: string }>`
            SELECT branch_name FROM qrspi_workflows WHERE workflow_id = ${input.workflowId}
          `
          const branchName = workflowRows[0]?.branch_name ?? input.proposedBranchName
          yield* sql`
            INSERT INTO qrspi_workflow_definitions (
              definition_sha256, definition_json, created_at
            ) VALUES (
              ${input.workflowDefinitionSha256}, ${JSON.stringify(input.workflowDefinition)}, ${now}
            ) ON CONFLICT (definition_sha256) DO NOTHING
          `
          yield* sql`
            INSERT INTO qrspi_ticket_revisions (
              workflow_id, ticket_revision_sha256, revision_json, checked_at
            ) VALUES (
              ${input.workflowId}, ${input.ticketRevision.ticketRevisionSha256},
              ${JSON.stringify(input.ticketRevision)}, ${input.ticketRevision.checkedAt.toISOString()}
            ) ON CONFLICT (workflow_id, ticket_revision_sha256) DO NOTHING
          `
          const currentRows = yield* sql<Record<string, unknown>>`
            SELECT * FROM workflow_operations
            WHERE logical_operation_id = ${`workflow-start:${input.workflowId}`} AND is_current = 1
          `
          const existing =
            currentRows[0] === undefined ? undefined : yield* decodeRow(currentRows[0])
          const replacingRetryableFailure =
            existing !== undefined &&
            existing.input_sha256 === input.inputSha256 &&
            existing.state === "failed" &&
            existing.terminal_retry_policy === "retryable"
          if (
            existing !== undefined &&
            existing.input_sha256 === input.inputSha256 &&
            !replacingRetryableFailure
          ) {
            return yield* toStartRecord(existing, branchName)
          }
          if (existing !== undefined) {
            if (replacingRetryableFailure) {
              yield* sql`
                UPDATE workflow_operations SET is_current = 0
                WHERE operation_id = ${existing.operation_id}
              `
            } else {
              yield* sql`
                UPDATE workflow_operation_gates SET state = 'cancelled'
                WHERE operation_id = ${existing.operation_id} AND state = 'pending'
              `
              yield* sql`
                UPDATE workflow_operations
                SET is_current = 0,
                    state = CASE WHEN state IN ('blocked', 'ready', 'leased', 'waiting_external',
                      'waiting_human') THEN 'superseded' ELSE state END,
                    last_error = CASE WHEN state IN ('blocked', 'ready', 'leased', 'waiting_external',
                      'waiting_human') THEN 'workflow start input changed' ELSE last_error END,
                    lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = ${now}
                WHERE operation_id = ${existing.operation_id}
              `
            }
          }
          const revisions = yield* sql<{ readonly revision: number }>`
            SELECT coalesce(max(operation_revision), 0) + 1 AS revision
            FROM workflow_operations WHERE logical_operation_id = ${`workflow-start:${input.workflowId}`}
          `
          const revision = Number(revisions[0]?.revision ?? 1)
          const operationId = `${input.workflowId}:start:${revision}`
          const retryOf = replacingRetryableFailure ? existing.operation_id : null
          yield* insertOperation(sql, {
            operationId,
            logicalOperationId: `workflow-start:${input.workflowId}`,
            revision,
            retryOf,
            kind: "WorkflowStart",
            scope: { _tag: "WorkflowScope", workflowId: input.workflowId },
            inputJson: input.inputJson,
            inputSha256: input.inputSha256,
            state: "leased",
            attempt: 1,
            leaseToken: input.leaseToken,
            leaseUntil: new Date(input.now.getTime() + input.leaseDurationMs),
            parentEffect: {
              success: "advance parent",
              failure: "audit only",
              retryExhausted: "fail operation",
              observationExhausted: "open operation-scoped gate",
            },
            now: input.now,
          })
          return yield* selectOperation(operationId).pipe(
            Effect.flatMap((row) => toStartRecord(row, branchName)),
          )
        }),
      )
      return operation.pipe(Effect.catchTag("QrspiStoreDataError", quarantine))
    },

    claimStart: (operationId, leaseToken, leaseDurationMs, now) => {
      const claim = transaction(
        Effect.gen(function* () {
          const claimed = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations
            SET state = 'leased', attempt = attempt + 1, lease_owner = 'workflow-start-ingress',
                lease_token = ${leaseToken},
                lease_until = ${new Date(now.getTime() + leaseDurationMs).toISOString()},
                updated_at = ${now.toISOString()}
            WHERE operation_id = ${operationId} AND is_current = 1 AND attempt < max_attempts
              AND (state = 'ready' OR (state = 'leased' AND lease_until <= ${now.toISOString()}))
            RETURNING operation_id
          `
          if (claimed.length !== 1) {
            const exhausted = yield* sql<{ readonly operation_id: string }>`
              UPDATE workflow_operations
              SET state = 'failed', last_error = 'retry budget exhausted',
                  terminal_failure_reason = 'retry budget exhausted',
                  terminal_retry_policy = 'retry_budget_exhausted',
                  updated_at = ${now.toISOString()}
              WHERE operation_id = ${operationId} AND is_current = 1 AND state = 'ready'
                AND attempt >= max_attempts
              RETURNING operation_id
            `
            if (exhausted.length === 1) {
              return new WorkflowStartRetryExhaustedError({ operationId })
            }
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId,
                reason: "operation is not claimable",
              }),
            )
          }
          const row = yield* selectOperation(operationId)
          const scope = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowScope))(
            row.scope_json,
          ).pipe(
            Effect.mapError((cause) => dataError("workflow_operation", row.operation_id, cause)),
          )
          const workflows = yield* sql<{ readonly branch_name: string }>`
            SELECT branch_name FROM qrspi_workflows
            WHERE workflow_id = ${scope.workflowId}
          `
          return yield* toStartRecord(row, workflows[0]?.branch_name ?? "missing")
        }),
      )
      return claim.pipe(
        Effect.flatMap((result) =>
          result instanceof WorkflowStartRetryExhaustedError
            ? Effect.fail(result)
            : Effect.succeed(result),
        ),
        Effect.catchTag("QrspiStoreDataError", quarantine),
      )
    },

    recordBranchIntent: (operationId, leaseToken, intentJson, now) =>
      sql<{ readonly operation_id: string }>`
        UPDATE workflow_operations
        SET external_intent_json = ${intentJson}, updated_at = ${now.toISOString()}
        WHERE operation_id = ${operationId} AND state = 'leased' AND is_current = 1
          AND lease_token = ${leaseToken} AND lease_until > ${now.toISOString()}
        RETURNING operation_id
      `.pipe(Effect.map((rows) => (rows.length === 1 ? "recorded" : "stale"))),

    validateLease: (operationId, leaseToken, now) =>
      sql<{ readonly operation_id: string }>`
        SELECT operation_id FROM workflow_operations
        WHERE operation_id = ${operationId} AND state = 'leased' AND is_current = 1
          AND lease_token = ${leaseToken} AND lease_until > ${now.toISOString()}
      `.pipe(Effect.map((rows) => rows.length === 1)),

    isStartCurrent: (operationId, inputSha256) =>
      sql<{ readonly operation_id: string }>`
        SELECT operation_id FROM workflow_operations
        WHERE operation_id = ${operationId} AND input_sha256 = ${inputSha256}
          AND state = 'succeeded' AND is_current = 1
      `.pipe(Effect.map((rows) => rows.length === 1)),

    markWaitingExternal: (operationId, leaseToken, observationJson, now) =>
      sql<{ readonly operation_id: string }>`
        UPDATE workflow_operations
        SET state = 'waiting_external', external_observation_json = ${observationJson},
            observation_attempts = observation_attempts + 1,
            lease_owner = NULL, lease_token = NULL, lease_until = NULL,
            updated_at = ${now.toISOString()}
        WHERE operation_id = ${operationId} AND state = 'leased' AND is_current = 1
          AND lease_token = ${leaseToken} AND lease_until > ${now.toISOString()}
        RETURNING operation_id
      `.pipe(Effect.map((rows) => (rows.length === 1 ? "recorded" : "stale"))),

    recordUnknownOutcome: (operationId, leaseToken, observationJson, now) =>
      sql<{ readonly operation_id: string }>`
        UPDATE workflow_operations
        SET state = 'waiting_external', external_observation_json = ${observationJson},
            observation_attempts = observation_attempts + 1,
            lease_owner = NULL, lease_token = NULL, lease_until = NULL,
            updated_at = ${now.toISOString()}
        WHERE operation_id = ${operationId} AND state = 'leased' AND is_current = 1
          AND lease_token = ${leaseToken}
        RETURNING operation_id
      `.pipe(Effect.map((rows) => (rows.length === 1 ? "recorded" : "stale"))),

    recoverExpiredLease: (operationId, outcome, observationJson, now, intentJson) =>
      transaction(
        Effect.gen(function* () {
          const state =
            outcome === "present"
              ? "waiting_external"
              : outcome === "absent"
                ? "failed"
                : "waiting_human"
          const rows = yield* sql<{ readonly state: typeof state }>`
            UPDATE workflow_operations
            SET state = ${state}, external_observation_json = ${observationJson},
                external_intent_json = CASE
                  WHEN ${state} = 'waiting_external'
                    THEN coalesce(external_intent_json, ${intentJson ?? null})
                  ELSE external_intent_json
                END,
                observation_attempts = observation_attempts + 1,
                last_error = CASE
                  WHEN ${state} = 'failed' THEN 'retry budget exhausted; branch absent'
                  ELSE last_error
                END,
                terminal_failure_reason = CASE
                  WHEN ${state} = 'failed' THEN 'retry budget exhausted; branch absent'
                  WHEN ${state} = 'waiting_human' THEN 'final-attempt external outcome is unknown'
                  ELSE terminal_failure_reason
                END,
                terminal_retry_policy = CASE
                  WHEN ${state} = 'failed' THEN 'retry_budget_exhausted'
                  WHEN ${state} = 'waiting_human' THEN 'operator_required'
                  ELSE terminal_retry_policy
                END,
                lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${now.toISOString()}
            WHERE operation_id = ${operationId} AND state = 'leased' AND is_current = 1
              AND lease_until <= ${now.toISOString()} AND attempt >= max_attempts
            RETURNING state
          `
          if (rows.length !== 1) return "stale" as const
          if (state === "waiting_human") {
            yield* sql`
              INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
              VALUES (
                ${operationId}, 'pending', 'final-attempt external outcome is unknown',
                ${now.toISOString()}
              ) ON CONFLICT (operation_id) DO NOTHING
            `
          }
          return state
        }),
      ),

    recordBranchAbsent: (operationId, observationJson, now) =>
      transaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly state: "ready" | "waiting_human" }>`
            UPDATE workflow_operations
            SET state = CASE
                  WHEN observation_attempts + 1 >= max_observation_attempts
                    THEN 'waiting_human'
                  ELSE 'ready'
                END,
                external_observation_json = ${observationJson},
                observation_attempts = observation_attempts + 1,
                terminal_failure_reason = CASE
                  WHEN observation_attempts + 1 >= max_observation_attempts
                    THEN 'external observation budget exhausted'
                  ELSE terminal_failure_reason
                END,
                terminal_retry_policy = CASE
                  WHEN observation_attempts + 1 >= max_observation_attempts
                    THEN 'operator_required'
                  ELSE terminal_retry_policy
                END,
                updated_at = ${now.toISOString()}
            WHERE operation_id = ${operationId} AND state = 'waiting_external'
              AND is_current = 1
            RETURNING state
          `
          const state = rows[0]?.state
          if (state === "waiting_human") {
            yield* sql`
              INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
              VALUES (
                ${operationId}, 'pending', 'external observation budget exhausted',
                ${now.toISOString()}
              ) ON CONFLICT (operation_id) DO NOTHING
            `
          }
          return state ?? "stale"
        }),
      ),

    supersedeStart: (operationId, reason, now) =>
      sql`
        UPDATE workflow_operations SET state = 'superseded', is_current = 0,
          last_error = ${reason}, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
          updated_at = ${now.toISOString()}
        WHERE operation_id = ${operationId} AND state NOT IN
          ('succeeded', 'failed', 'cancelled', 'superseded', 'data_error')
      `.pipe(Effect.asVoid),

    failStart: (operationId, reason, retryPolicy, now) =>
      sql`
        UPDATE workflow_operations SET state = 'failed', last_error = ${reason},
          terminal_failure_reason = ${reason}, terminal_retry_policy = ${retryPolicy},
          lease_owner = NULL, lease_token = NULL, lease_until = NULL,
          updated_at = ${now.toISOString()}
        WHERE operation_id = ${operationId} AND state NOT IN
          ('succeeded', 'failed', 'cancelled', 'superseded', 'data_error')
      `.pipe(Effect.asVoid),

    waitStartForOperator: (operationId, reason, now) =>
      transaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations SET state = 'waiting_human', last_error = ${reason},
              terminal_failure_reason = ${reason}, terminal_retry_policy = 'operator_required',
              lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              updated_at = ${now.toISOString()}
            WHERE operation_id = ${operationId} AND is_current = 1 AND state IN
              ('blocked', 'ready', 'leased', 'waiting_external')
            RETURNING operation_id
          `
          if (rows.length === 1) {
            yield* sql`
              INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
              VALUES (${operationId}, 'pending', ${reason}, ${now.toISOString()})
              ON CONFLICT (operation_id) DO NOTHING
            `
          }
        }),
      ),

    completeStart: (input) => {
      const completion = transaction(
        Effect.gen(function* () {
          const operation = yield* selectOperation(input.operationId)
          if (operation.is_current !== 1 || operation.state !== "waiting_external") {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "operation is not current waiting_external work",
              }),
            )
          }
          const persistedInput = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowStartInput))(
            operation.input_json,
          ).pipe(
            Effect.mapError((cause) => dataError("workflow_operation", input.operationId, cause)),
          )
          const persistedScope = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowScope))(
            operation.scope_json,
          ).pipe(
            Effect.mapError((cause) => dataError("workflow_operation", input.operationId, cause)),
          )
          const suppliedRepository = yield* Schema.decodeUnknown(
            Schema.parseJson(RepositoryReference),
          )(input.repositoryJson).pipe(
            Effect.mapError(
              (cause) =>
                new WorkflowStartCurrentnessError({
                  operationId: input.operationId,
                  reason: `supplied repository is invalid: ${String(cause)}`,
                }),
            ),
          )
          const authoritativeObservation = yield* Schema.decodeUnknown(
            Schema.Struct({
              headRef: Schema.NonEmptyString,
              sha: Schema.String.pipe(Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)),
            }),
          )(input.authoritativeObservation).pipe(
            Effect.mapError(
              () =>
                new WorkflowStartCurrentnessError({
                  operationId: input.operationId,
                  reason: "authoritative branch observation is missing or malformed",
                }),
            ),
          )
          if (
            persistedScope.workflowId !== input.workflowId ||
            persistedInput.ticketRevisionSha256 !== input.ticketRevisionSha256 ||
            persistedInput.workflowDefinitionSha256 !== input.workflowDefinitionSha256 ||
            persistedInput.baseRef !== input.baseRef ||
            persistedInput.baseSha !== input.baseSha ||
            persistedInput.branchName !== input.branchName ||
            canonicalSha256(persistedInput.repository) !== canonicalSha256(suppliedRepository) ||
            authoritativeObservation.headRef !== input.branchName ||
            authoritativeObservation.sha !== input.rootSha
          ) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "supplied completion target does not match persisted WorkflowStart input",
              }),
            )
          }
          const definitionRows = yield* sql<{ readonly definition_json: string }>`
            SELECT definition_json FROM qrspi_workflow_definitions
            WHERE definition_sha256 = ${input.workflowDefinitionSha256}
          `
          const definitionJson = definitionRows[0]?.definition_json
          if (definitionJson === undefined) {
            return yield* Effect.fail(
              dataError(
                "workflow_definition",
                input.workflowDefinitionSha256,
                "missing definition",
              ),
            )
          }
          const definition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(
            definitionJson,
          ).pipe(
            Effect.mapError((cause) =>
              dataError("workflow_definition", input.workflowDefinitionSha256, cause),
            ),
          )
          if (workflowDefinitionSha256(definition) !== input.workflowDefinitionSha256) {
            return yield* Effect.fail(
              dataError("workflow_definition", input.workflowDefinitionSha256, "hash mismatch"),
            )
          }
          yield* sql`
            UPDATE qrspi_generations SET
              state = CASE
                WHEN state IN ('completed', 'rejected', 'cancelled', 'failed') THEN state
                ELSE 'superseded'
              END,
              is_current = 0,
              updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${input.workflowId} AND is_current = 1
          `
          yield* sql`
            UPDATE workflow_operation_gates SET state = 'cancelled'
            WHERE state = 'pending' AND operation_id IN (
              SELECT operation_id FROM workflow_operations
              WHERE operation_id != ${input.operationId}
                AND json_extract(scope_json, '$.workflowId') = ${input.workflowId}
                AND json_extract(scope_json, '$._tag') = 'GenerationScope'
                AND state IN ('blocked', 'ready', 'leased', 'waiting_external', 'waiting_human')
            )
          `
          yield* sql`
            UPDATE workflow_operations SET state = 'superseded', is_current = 0,
              last_error = 'newer generation', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, updated_at = ${input.now.toISOString()}
            WHERE operation_id != ${input.operationId}
              AND json_extract(scope_json, '$.workflowId') = ${input.workflowId}
              AND json_extract(scope_json, '$._tag') = 'GenerationScope'
              AND state IN ('blocked', 'ready', 'leased', 'waiting_external', 'waiting_human')
          `
          const generations = yield* sql<{ readonly generation: number }>`
            SELECT coalesce(max(generation), 0) + 1 AS generation
            FROM qrspi_generations WHERE workflow_id = ${input.workflowId}
          `
          const generation = Number(generations[0]?.generation ?? 1)
          const output = yield* Schema.decodeUnknown(WorkflowStartOutput)({
            _tag: "Started",
            workflowId: input.workflowId,
            generation,
            branchName: input.branchName,
            rootSha: input.rootSha,
            ticketRevisionSha256: input.ticketRevisionSha256,
          }).pipe(
            Effect.mapError((cause) => dataError("workflow_operation", input.operationId, cause)),
          )
          yield* sql`
            INSERT INTO qrspi_generations (
              workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
              root_sha, current_head_sha, ticket_revision_sha256,
              workflow_definition_sha256, state, is_current, created_at, updated_at
            ) VALUES (
              ${input.workflowId}, ${generation}, ${input.repositoryJson}, ${input.baseRef},
              ${input.baseSha}, ${input.branchName}, ${input.rootSha}, ${input.rootSha},
              ${input.ticketRevisionSha256}, ${input.workflowDefinitionSha256}, 'running', 1,
              ${input.now.toISOString()}, ${input.now.toISOString()}
            )
          `
          const configuredStages = definition.stages.filter(
            (stage) => stage.activation.mode !== "disabled",
          )
          const firstStage = configuredStages.find(
            (stage) =>
              stage.activation.mode === "enabled" ||
              (stage.activation.mode === "conditional" && stage.activation.decision === "enabled"),
          )
          for (const [position, stage] of configuredStages.entries()) {
            const skipped =
              stage.activation.mode === "conditional" && stage.activation.decision === "disabled"
            const active = stage === firstStage
            const state = skipped ? "skipped" : active ? "active" : "blocked"
            const pendingRevision = active ? 1 : null
            const skipReason = skipped
              ? `${stage.activation.policyId}@${stage.activation.policyVersion} disabled the stage`
              : null
            yield* sql`
              INSERT INTO qrspi_stage_runs (
                workflow_id, generation, stage_key, stage_position, stage_definition_sha256,
                state, published_revision, pending_revision, accepted_revision, skip_reason,
                created_at, updated_at
              ) VALUES (
                ${input.workflowId}, ${generation}, ${stage.key}, ${position},
                ${stageDefinitionSha256(stage)}, ${state}, NULL, ${pendingRevision}, NULL, ${skipReason},
                ${input.now.toISOString()}, ${input.now.toISOString()}
              )
            `
            if (active) {
              yield* sql`
                INSERT INTO qrspi_stage_revisions (
                  workflow_id, generation, stage_key, revision, revision_type,
                  source_artifacts_json, state, created_at, updated_at
                ) VALUES (
                  ${input.workflowId}, ${generation}, ${stage.key}, 1, ${stage.kind},
                  '[]', 'producing', ${input.now.toISOString()}, ${input.now.toISOString()}
                )
              `
            }
          }
          if (firstStage !== undefined) {
            for (const initial of firstStage.initialOperations) {
              const logical = `${input.workflowId}:${generation}:${initial.kind}:${firstStage.key}:1`
              const childInput = {
                stageKey: firstStage.key,
                stageKind: firstStage.kind,
                stageRevision: 1,
                workflowDefinitionSha256: input.workflowDefinitionSha256,
                ticketRevisionSha256: input.ticketRevisionSha256,
                sources: [],
                ...(initial.parameters === undefined ? {} : { parameters: initial.parameters }),
              }
              yield* insertOperation(sql, {
                operationId: `${logical}:1`,
                logicalOperationId: logical,
                revision: 1,
                retryOf: null,
                kind: initial.kind,
                scope: { _tag: "GenerationScope", workflowId: input.workflowId, generation },
                inputJson: JSON.stringify(childInput),
                inputSha256: canonicalSha256(childInput),
                state: initial.state,
                attempt: 0,
                maxAttempts:
                  initial.kind === "StageProduce" ? firstStage.producer.retry.maxAttempts : 3,
                parentEffect: initial.parentEffect,
                now: input.now,
              })
            }
          }
          yield* sql`
            UPDATE workflow_operations
            SET state = 'succeeded', output_json = ${JSON.stringify(output)},
                external_observation_json = ${JSON.stringify({
                  headRef: input.branchName,
                  sha: input.rootSha,
                })},
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND is_current = 1
          `
          return output
        }),
      )
      return completion.pipe(Effect.catchTag("QrspiStoreDataError", quarantine))
    },

    claimStageOperation: (kind, workerId, leaseToken, leaseDurationMs, now) =>
      transaction(
        Effect.gen(function* () {
          const abandonedSessions = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations
            SET state = 'waiting_human', terminal_failure_reason = 'recorded agent session lease expired',
                terminal_retry_policy = 'operator_required', lease_owner = NULL, lease_token = NULL,
                lease_until = NULL, updated_at = ${now.toISOString()}
            WHERE kind = 'StageProduce' AND is_current = 1 AND state = 'leased'
              AND lease_until <= ${now.toISOString()}
              AND (
                json_type(external_intent_json, '$.agentExecution.launchIntent') = 'object'
                OR json_type(external_intent_json, '$.agentExecution.sessionReference') = 'object'
              )
            RETURNING operation_id
          `
          yield* Effect.forEach(
            abandonedSessions,
            ({ operation_id }) => sql`
              INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
              VALUES (${operation_id}, 'pending', 'recorded agent session lease expired', ${now.toISOString()})
              ON CONFLICT (operation_id) DO NOTHING
            `,
            { discard: true },
          )
          yield* sql`
            UPDATE workflow_operations
            SET state = 'failed', last_error = 'retry budget exhausted after lease expiry',
                terminal_failure_reason = 'retry budget exhausted after lease expiry',
                terminal_retry_policy = 'retry_budget_exhausted',
                lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${now.toISOString()}
            WHERE kind = ${kind} AND is_current = 1 AND state = 'leased'
              AND lease_until <= ${now.toISOString()} AND attempt >= max_attempts
          `
          yield* sql`
            UPDATE qrspi_stage_runs SET state = 'failed', pending_revision = NULL,
              updated_at = ${now.toISOString()}
            WHERE state = 'active' AND EXISTS (
              SELECT 1 FROM workflow_operations o
              WHERE o.kind = ${kind} AND o.state = 'failed' AND o.is_current = 1
                AND o.updated_at = ${now.toISOString()}
                AND json_extract(o.scope_json, '$.workflowId') = qrspi_stage_runs.workflow_id
                AND json_extract(o.scope_json, '$.generation') = qrspi_stage_runs.generation
                AND json_extract(o.input_json, '$.stageKey') = qrspi_stage_runs.stage_key
            )
          `
          yield* sql`
            UPDATE qrspi_generations SET state = 'failed', updated_at = ${now.toISOString()}
            WHERE state = 'running' AND EXISTS (
              SELECT 1 FROM workflow_operations o
              WHERE o.kind = ${kind} AND o.state = 'failed' AND o.is_current = 1
                AND o.updated_at = ${now.toISOString()}
                AND json_extract(o.parent_effect_json, '$.failure') = 'fail Generation'
                AND json_extract(o.scope_json, '$.workflowId') = qrspi_generations.workflow_id
                AND json_extract(o.scope_json, '$.generation') = qrspi_generations.generation
            )
          `
          const rows = yield* sql<{
            readonly controller_id: string
            readonly operation_id: string
            readonly operation_revision: number
            readonly attempt: number
            readonly scope_json: string
            readonly input_json: string
            readonly definition_json: string
            readonly repository_json: string
            readonly head_ref: string
            readonly current_head_sha: string
            readonly prepared_result_json: string | null
            readonly ticket_id: string
            readonly ticket_revision_json: string
            readonly produce_output_json: string | null
            readonly implementation_commits_json: string
            readonly predecessor_session_reference_id: string | null
          }>`
            UPDATE workflow_operations
            SET state = 'leased', attempt = attempt + 1, lease_owner = ${workerId},
                lease_token = ${leaseToken},
                lease_until = ${new Date(now.getTime() + leaseDurationMs).toISOString()},
                updated_at = ${now.toISOString()}
            WHERE operation_id = (
              SELECT operation_id FROM workflow_operations
              WHERE kind = ${kind} AND is_current = 1
                AND (state = 'ready' OR (state = 'leased' AND lease_until <= ${now.toISOString()}))
                AND run_at <= ${now.toISOString()} AND attempt < max_attempts
              ORDER BY run_at, operation_id LIMIT 1
            )
            RETURNING (SELECT controller_id FROM workflowd_controller WHERE singleton = 1)
                AS controller_id,
              operation_id, operation_revision, attempt, scope_json, input_json,
              (SELECT d.definition_json FROM qrspi_workflow_definitions d
                JOIN qrspi_generations g ON g.workflow_definition_sha256 = d.definition_sha256
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS definition_json,
              (SELECT g.repository_json FROM qrspi_generations g
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS repository_json,
              (SELECT g.head_ref FROM qrspi_generations g
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS head_ref,
              (SELECT g.current_head_sha FROM qrspi_generations g
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS current_head_sha,
              (SELECT r.prepared_result_json FROM qrspi_stage_revisions r
                WHERE r.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND r.generation = json_extract(scope_json, '$.generation')
                  AND r.stage_key = json_extract(input_json, '$.stageKey')
                  AND r.revision = json_extract(input_json, '$.stageRevision')) AS prepared_result_json,
              (SELECT json_extract(t.revision_json, '$.readyTicket.reference.nativeTicketId')
                FROM qrspi_ticket_revisions t JOIN qrspi_generations g
                  ON g.workflow_id = t.workflow_id
                  AND g.ticket_revision_sha256 = t.ticket_revision_sha256
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                   AND g.generation = json_extract(scope_json, '$.generation')) AS ticket_id,
              (SELECT t.revision_json
                FROM qrspi_ticket_revisions t JOIN qrspi_generations g
                  ON g.workflow_id = t.workflow_id
                  AND g.ticket_revision_sha256 = t.ticket_revision_sha256
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS ticket_revision_json,
              (SELECT p.output_json FROM workflow_operations p
                WHERE p.kind = 'StageProduce'
                  AND json_extract(p.scope_json, '$.workflowId') = json_extract(scope_json, '$.workflowId')
                  AND json_extract(p.scope_json, '$.generation') = json_extract(scope_json, '$.generation')
                  AND json_extract(p.input_json, '$.stageKey') = json_extract(input_json, '$.stageKey')
                  AND json_extract(p.input_json, '$.stageRevision') = json_extract(input_json, '$.stageRevision')
                  AND coalesce(json_extract(p.input_json, '$.stepPosition'), 1) =
                    coalesce(json_extract(input_json, '$.stepPosition'), 1)
                  AND p.state = 'succeeded' AND p.is_current = 1) AS produce_output_json,
              (SELECT coalesce(json_group_array(json(s.commit_reference_json)), '[]')
                FROM qrspi_implementation_steps s
                WHERE s.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND s.generation = json_extract(scope_json, '$.generation')
                  AND s.stage_key = json_extract(input_json, '$.stageKey')
                  AND s.revision = json_extract(input_json, '$.stageRevision')
                ORDER BY s.position) AS implementation_commits_json,
              (SELECT s.session_reference_id FROM qrspi_implementation_steps s
                WHERE s.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND s.generation = json_extract(scope_json, '$.generation')
                  AND s.stage_key = json_extract(input_json, '$.stageKey')
                  AND s.revision = json_extract(input_json, '$.stageRevision')
                ORDER BY s.position DESC LIMIT 1) AS predecessor_session_reference_id
          `
          const row = rows[0]
          if (row === undefined) return null
          const scope = yield* decodeGenerationScope(row.scope_json)
          const operationInput = yield* decodeStageOperationInput(row.input_json)
          const definition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(
            row.definition_json,
          )
          const stage = definition.stages.find(({ key }) => key === operationInput.stageKey)
          if (stage === undefined)
            return yield* Effect.fail(new Error("Retained stage definition is missing"))
          const repository = yield* Schema.decodeUnknown(Schema.parseJson(RepositoryReference))(
            row.repository_json,
          )
          const preparedResult =
            row.prepared_result_json === null
              ? undefined
              : yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(
                  row.prepared_result_json,
                )
          const produceOutput =
            row.produce_output_json === null
              ? undefined
              : yield* Schema.decodeUnknown(
                  Schema.parseJson(Schema.Struct({ sessionReferenceId: Schema.NonEmptyString })),
                )(row.produce_output_json)
          const implementationCommits = yield* Schema.decodeUnknown(
            Schema.parseJson(Schema.Array(ImplementationCommitReference)),
          )(row.implementation_commits_json)
          const ticketRevision = yield* Schema.decodeUnknown(
            Schema.parseJson(Schema.Struct({ readyTicket: ReadyTicket })),
          )(row.ticket_revision_json)
          return {
            controllerId: row.controller_id,
            operationId: row.operation_id,
            operationRevision: Number(row.operation_revision),
            attempt: Number(row.attempt),
            leaseToken,
            scope,
            input: operationInput,
            stage,
            repository,
            headRef: row.head_ref,
            currentHeadSha: row.current_head_sha,
            ticketId: row.ticket_id,
            readyTicket: ticketRevision.readyTicket,
            ...(produceOutput === undefined
              ? {}
              : { sessionReferenceId: produceOutput.sessionReferenceId }),
            ...(row.predecessor_session_reference_id === null
              ? {}
              : { predecessorSessionReferenceId: row.predecessor_session_reference_id }),
            ...(preparedResult === undefined ? {} : { preparedResult }),
            ...(operationInput.stageKind === "implementation" ? { implementationCommits } : {}),
          }
        }),
      ),

    recordStageAgentLaunchIntent: (input) =>
      sql<{ readonly operation_id: string }>`
        UPDATE workflow_operations
        SET external_intent_json = ${JSON.stringify({
          agentExecution: {
            launchIntent: input.launchIntent,
          },
        })}, updated_at = ${input.now.toISOString()}
        WHERE operation_id = ${input.operationId} AND kind = 'StageProduce'
          AND state = 'leased' AND is_current = 1 AND lease_token = ${input.leaseToken}
          AND lease_until > ${input.now.toISOString()}
        RETURNING operation_id
      `.pipe(Effect.map((rows) => (rows.length === 1 ? "recorded" : "stale"))),

    recordStageAgentSessionReference: (input) =>
      sql<{ readonly operation_id: string }>`
        UPDATE workflow_operations
        SET external_intent_json = json_set(external_intent_json,
              '$.agentExecution.sessionReference', json(${JSON.stringify(input.reference)})),
            updated_at = ${input.now.toISOString()}
        WHERE operation_id = ${input.operationId} AND kind = 'StageProduce'
          AND state = 'leased' AND is_current = 1 AND lease_token = ${input.leaseToken}
          AND lease_until > ${input.now.toISOString()}
          AND json_extract(external_intent_json,
            '$.agentExecution.launchIntent.sessionReferenceId') = ${input.reference.sessionReferenceId}
        RETURNING operation_id
      `.pipe(Effect.map((rows) => (rows.length === 1 ? "recorded" : "stale"))),

    requireStageSessionCleanup: (input) =>
      transaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations
            SET state = 'waiting_human',
                terminal_failure_reason = ${input.error},
                terminal_retry_policy = 'operator_required',
                lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND kind = 'StageProduce'
              AND state = 'leased' AND is_current = 1 AND lease_token = ${input.leaseToken}
              AND lease_until > ${input.now.toISOString()}
              AND (
                json_extract(external_intent_json,
                  '$.agentExecution.launchIntent.sessionReferenceId') = ${input.sessionReferenceId}
                OR json_extract(external_intent_json,
                  '$.agentExecution.sessionReference.sessionReferenceId') = ${input.sessionReferenceId}
              )
            RETURNING operation_id
          `
          if (rows.length !== 1) return "stale" as const
          yield* sql`
            INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
            VALUES (${input.operationId}, 'pending', ${input.error}, ${input.now.toISOString()})
            ON CONFLICT (operation_id) DO NOTHING
          `
          return "waiting_human" as const
        }),
      ),

    findArtifactPublicationRecovery: () =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly controller_id: string
          readonly operation_id: string
          readonly operation_revision: number
          readonly attempt: number
          readonly scope_json: string
          readonly input_json: string
          readonly definition_json: string
          readonly repository_json: string
          readonly head_ref: string
          readonly current_head_sha: string
          readonly prepared_result_json: string
          readonly ticket_id: string
          readonly ticket_revision_json: string
          readonly produce_output_json: string
          readonly external_intent_json: string
          readonly implementation_commits_json: string
        }>`
          SELECT c.controller_id, o.operation_id, o.operation_revision, o.attempt,
            o.scope_json, o.input_json,
            d.definition_json, g.repository_json, g.head_ref, g.current_head_sha,
            r.prepared_result_json, t.revision_json AS ticket_revision_json,
            json_extract(t.revision_json, '$.readyTicket.reference.nativeTicketId') AS ticket_id,
            p.output_json AS produce_output_json, o.external_intent_json,
            (SELECT coalesce(json_group_array(json(s.commit_reference_json)), '[]')
              FROM qrspi_implementation_steps s
              WHERE s.workflow_id = g.workflow_id AND s.generation = g.generation
                AND s.stage_key = r.stage_key AND s.revision = r.revision
              ORDER BY s.position) AS implementation_commits_json
          FROM workflow_operations o
          CROSS JOIN workflowd_controller c
          JOIN qrspi_generations g
            ON g.workflow_id = json_extract(o.scope_json, '$.workflowId')
            AND g.generation = json_extract(o.scope_json, '$.generation')
          JOIN qrspi_workflow_definitions d
            ON d.definition_sha256 = g.workflow_definition_sha256
          JOIN qrspi_stage_revisions r
            ON r.workflow_id = g.workflow_id AND r.generation = g.generation
            AND r.stage_key = json_extract(o.input_json, '$.stageKey')
            AND r.revision = json_extract(o.input_json, '$.stageRevision')
          JOIN qrspi_ticket_revisions t
            ON t.workflow_id = g.workflow_id
            AND t.ticket_revision_sha256 = g.ticket_revision_sha256
          JOIN workflow_operations p
            ON p.kind = 'StageProduce' AND p.state = 'succeeded' AND p.is_current = 1
            AND json_extract(p.scope_json, '$.workflowId') = g.workflow_id
            AND json_extract(p.scope_json, '$.generation') = g.generation
            AND json_extract(p.input_json, '$.stageKey') = r.stage_key
            AND json_extract(p.input_json, '$.stageRevision') = r.revision
            AND coalesce(json_extract(p.input_json, '$.stepPosition'), 1) =
              coalesce(json_extract(o.input_json, '$.stepPosition'), 1)
          WHERE o.kind = 'ArtifactPublish' AND o.state = 'waiting_external'
            AND o.is_current = 1 AND g.is_current = 1 AND g.state = 'running'
          ORDER BY o.updated_at, o.operation_id LIMIT 1
        `
        const row = rows[0]
        if (row === undefined) return null
        const scope = yield* decodeGenerationScope(row.scope_json)
        const operationInput = yield* decodeStageOperationInput(row.input_json)
        const definition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(
          row.definition_json,
        )
        const stage = definition.stages.find(({ key }) => key === operationInput.stageKey)
        if (stage === undefined)
          return yield* Effect.fail(new Error("Retained stage definition is missing"))
        const repository = yield* Schema.decodeUnknown(Schema.parseJson(RepositoryReference))(
          row.repository_json,
        )
        const preparedResult = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(
          row.prepared_result_json,
        )
        const produceOutput = yield* Schema.decodeUnknown(
          Schema.parseJson(Schema.Struct({ sessionReferenceId: Schema.NonEmptyString })),
        )(row.produce_output_json)
        const implementationCommits = yield* Schema.decodeUnknown(
          Schema.parseJson(Schema.Array(ImplementationCommitReference)),
        )(row.implementation_commits_json)
        const ticketRevision = yield* Schema.decodeUnknown(
          Schema.parseJson(Schema.Struct({ readyTicket: ReadyTicket })),
        )(row.ticket_revision_json)
        const intent = yield* Schema.decodeUnknown(
          Schema.parseJson(
            Schema.Union(
              Schema.Struct({
                expectedOld: Schema.String,
                finalSha: Schema.String,
                artifact: ArtifactReference,
              }),
              Schema.Struct({
                expectedOld: Schema.String,
                commit: ImplementationCommitReference,
              }),
            ),
          ),
        )(row.external_intent_json)
        const work = {
          controllerId: row.controller_id,
          operationId: row.operation_id,
          operationRevision: Number(row.operation_revision),
          attempt: Number(row.attempt),
          leaseToken: "authoritative-recovery",
          scope,
          input: operationInput,
          stage,
          repository,
          headRef: row.head_ref,
          currentHeadSha: row.current_head_sha,
          preparedResult,
          ticketId: row.ticket_id,
          readyTicket: ticketRevision.readyTicket,
          sessionReferenceId: produceOutput.sessionReferenceId,
          ...(operationInput.stageKind === "implementation" ? { implementationCommits } : {}),
        }
        return "artifact" in intent
          ? {
              ...work,
              bound: {
                finalSha: intent.finalSha,
                parentSha: intent.expectedOld,
                artifact: intent.artifact,
              },
            }
          : { ...work, implementationCommit: intent.commit }
      }),

    isStageOperationCurrent: (operationId, leaseToken, now) =>
      sql<{ readonly operation_id: string }>`
        SELECT o.operation_id FROM workflow_operations o
        JOIN qrspi_generations g
          ON g.workflow_id = json_extract(o.scope_json, '$.workflowId')
          AND g.generation = json_extract(o.scope_json, '$.generation')
        JOIN qrspi_stage_runs r
          ON r.workflow_id = g.workflow_id AND r.generation = g.generation
          AND r.stage_key = json_extract(o.input_json, '$.stageKey')
        WHERE o.operation_id = ${operationId} AND o.is_current = 1
          AND ((o.state = 'leased' AND o.lease_token = ${leaseToken}
            AND o.lease_until > ${now.toISOString()}) OR o.state = 'waiting_external')
          AND g.is_current = 1 AND g.state = 'running' AND r.state = 'active'
          AND r.pending_revision = json_extract(o.input_json, '$.stageRevision')
      `.pipe(Effect.map((rows) => rows.length === 1)),

    isTrustedArtifactPublication: (input) =>
      sql<{ readonly expected_old: string }>`
        SELECT json_extract(o.external_intent_json, '$.expectedOld') AS expected_old
        FROM workflow_operations o
        CROSS JOIN workflowd_controller c
        JOIN qrspi_generations g
          ON g.workflow_id = json_extract(o.scope_json, '$.workflowId')
          AND g.generation = json_extract(o.scope_json, '$.generation')
        WHERE c.controller_id = ${input.controllerId}
          AND o.operation_id = ${input.operationId}
          AND o.kind = 'ArtifactPublish'
          AND o.external_intent_json IS NOT NULL
          AND json_extract(g.repository_json, '$.providerInstanceId') = ${input.repository.providerInstanceId}
          AND json_extract(g.repository_json, '$.repositoryId') = ${input.repository.repositoryId}
          AND json_extract(g.repository_json, '$.repositoryFullName') = ${input.repository.repositoryFullName}
          AND g.head_ref = ${input.headRef}
          AND coalesce(
            json_extract(o.external_intent_json, '$.finalSha'),
            json_extract(o.external_intent_json, '$.commit.commitSha')
          ) = ${input.commitSha}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.expected_old ?? null)),

    rescheduleStageOperation: (input) =>
      transaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly attempt: number; readonly max_attempts: number }>`
            SELECT attempt, max_attempts FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND state = 'leased' AND is_current = 1
              AND lease_token = ${input.leaseToken}
              AND lease_until > ${input.now.toISOString()}
              AND (
                kind != 'StageProduce'
                OR json_extract(external_intent_json,
                  '$.agentExecution.sessionReference.sessionReferenceId') IS NULL
                OR json_extract(external_intent_json,
                  '$.agentExecution.sessionReference.sessionReferenceId') =
                    ${input.confirmedAbortedSessionReferenceId ?? null}
              )
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const failed = Number(row.attempt) >= Number(row.max_attempts)
          const updated = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations
            SET state = ${failed ? "failed" : "ready"}, run_at = ${input.runAt.toISOString()},
                last_error = ${input.error}, lease_owner = NULL, lease_token = NULL,
                lease_until = NULL, terminal_failure_reason = ${failed ? input.error : null},
                terminal_retry_policy = ${failed ? "retry_budget_exhausted" : null},
                external_intent_json = CASE
                  WHEN ${input.confirmedAbortedSessionReferenceId ?? null} IS NULL
                    THEN external_intent_json
                  ELSE json_set(external_intent_json,
                    '$.agentExecution.sessionReference.state', 'superseded')
                  END,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND state = 'leased' AND is_current = 1
              AND lease_token = ${input.leaseToken}
              AND lease_until > ${input.now.toISOString()}
            RETURNING operation_id
          `
          if (updated.length !== 1) return "stale" as const
          if (failed) {
            yield* sql`
              UPDATE qrspi_stage_runs SET state = 'failed', pending_revision = NULL,
                updated_at = ${input.now.toISOString()}
              WHERE workflow_id = json_extract((SELECT scope_json FROM workflow_operations
                WHERE operation_id = ${input.operationId}), '$.workflowId')
                AND generation = json_extract((SELECT scope_json FROM workflow_operations
                WHERE operation_id = ${input.operationId}), '$.generation')
                AND stage_key = json_extract((SELECT input_json FROM workflow_operations
                WHERE operation_id = ${input.operationId}), '$.stageKey')
            `
            yield* sql`
              UPDATE qrspi_generations SET state = 'failed', updated_at = ${input.now.toISOString()}
              WHERE state = 'running'
                AND workflow_id = json_extract((SELECT scope_json FROM workflow_operations
                  WHERE operation_id = ${input.operationId}), '$.workflowId')
                AND generation = json_extract((SELECT scope_json FROM workflow_operations
                  WHERE operation_id = ${input.operationId}), '$.generation')
                AND json_extract((SELECT parent_effect_json FROM workflow_operations
                  WHERE operation_id = ${input.operationId}), '$.failure') = 'fail Generation'
            `
          }
          return failed ? ("failed" as const) : ("rescheduled" as const)
        }),
      ),

    recordArtifactPublicationOutcome: (input) =>
      transaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly state: "waiting_external" | "waiting_human" }>`
            UPDATE workflow_operations
            SET state = CASE
                  WHEN ${input.outcome} = 'conflict'
                    OR observation_attempts + 1 >= max_observation_attempts
                  THEN 'waiting_human' ELSE 'waiting_external' END,
                observation_attempts = observation_attempts + 1,
                external_observation_json = ${JSON.stringify({
                  outcome: input.outcome,
                  observedHeadSha: input.observedHeadSha,
                })},
                terminal_failure_reason = CASE
                  WHEN ${input.outcome} = 'conflict' THEN 'ticket ref exact-old conflict'
                  WHEN observation_attempts + 1 >= max_observation_attempts
                    THEN 'publication observation budget exhausted'
                  ELSE terminal_failure_reason END,
                terminal_retry_policy = CASE
                  WHEN ${input.outcome} = 'conflict'
                    OR observation_attempts + 1 >= max_observation_attempts
                  THEN 'operator_required' ELSE terminal_retry_policy END,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish'
              AND state = 'waiting_external' AND is_current = 1
            RETURNING state
          `
          const state = rows[0]?.state
          if (state === undefined) return "stale" as const
          if (state === "waiting_human") {
            yield* sql`
              INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
              VALUES (
                ${input.operationId}, 'pending',
                ${input.outcome === "conflict" ? "ticket ref exact-old conflict" : "publication observation budget exhausted"},
                ${input.now.toISOString()}
              ) ON CONFLICT (operation_id) DO NOTHING
            `
          }
          return state
        }),
      ),

    recordStaleArtifactPublicationEffect: (input) =>
      transaction(
        Effect.gen(function* () {
          if (input.observedHeadSha !== input.finalSha) return "stale" as const
          const rows = yield* sql<{
            readonly scope_json: string
            readonly external_intent_json: string
          }>`
            SELECT scope_json, external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish'
              AND state IN ('waiting_external', 'superseded')
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const intent = yield* Schema.decodeUnknown(
            Schema.parseJson(
              Schema.Union(
                Schema.Struct({
                  expectedOld: Schema.String,
                  finalSha: Schema.String,
                  artifact: ArtifactReference,
                }),
                Schema.Struct({
                  expectedOld: Schema.String,
                  commit: ImplementationCommitReference,
                }),
              ),
            ),
          )(row.external_intent_json)
          const boundFinalSha = "finalSha" in intent ? intent.finalSha : intent.commit.commitSha
          if (intent.expectedOld !== input.expectedOld || boundFinalSha !== input.finalSha) {
            return "stale" as const
          }
          const scope = yield* decodeGenerationScope(row.scope_json)
          const generations = yield* sql<{ readonly head_ref: string }>`
            SELECT head_ref FROM qrspi_generations
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
          `
          const headRef = generations[0]?.head_ref
          if (headRef === undefined) return "stale" as const
          yield* sql`
            UPDATE workflow_operations
            SET state = 'superseded', is_current = 0,
                external_observation_json = ${JSON.stringify({
                  headRef,
                  sha: input.observedHeadSha,
                  outcome: "stale_effect",
                })}, last_error = 'external publication completed after currentness was lost',
                lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish'
              AND state IN ('waiting_external', 'superseded')
          `
          yield* sql`
            UPDATE qrspi_generations SET state = 'reconciling', updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND is_current = 1
              AND state NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'superseded')
          `
          const reconciliationIdentity = canonicalSha256({
            staleOperationId: input.operationId,
            expectedOld: input.expectedOld,
            observedHeadSha: input.observedHeadSha,
          })
          const logical = `${scope.workflowId}:TargetReconcile:${reconciliationIdentity}`
          const existing = yield* sql<{ readonly operation_id: string }>`
            SELECT operation_id FROM workflow_operations
            WHERE logical_operation_id = ${logical} AND is_current = 1
          `
          if (existing.length === 0) {
            const reconciliationInput = {
              staleOperationId: input.operationId,
              generation: scope.generation,
              headRef,
              expectedOld: input.expectedOld,
              observedHeadSha: input.observedHeadSha,
            }
            yield* insertOperation(sql, {
              operationId: `${logical}:1`,
              logicalOperationId: logical,
              revision: 1,
              retryOf: null,
              kind: "TargetReconcile",
              scope: { _tag: "WorkflowScope", workflowId: scope.workflowId },
              inputJson: JSON.stringify(reconciliationInput),
              inputSha256: canonicalSha256(reconciliationInput),
              state: "ready",
              attempt: 0,
              parentEffect: { success: "audit only", failure: "open operation-scoped gate" },
              now: input.now,
            })
          }
          return "reconciling" as const
        }),
      ),

    completeStageProduce: (input) =>
      transaction(
        Effect.gen(function* () {
          const output = yield* Schema.decodeUnknown(
            Schema.Record({ key: Schema.String, value: Schema.Unknown }),
          )(input.preparedResult)
          const rows = yield* sql<{
            readonly operation_id: string
            readonly scope_json: string
            readonly input_json: string
          }>`
            SELECT operation_id, scope_json, input_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'StageProduce'
              AND state = 'leased' AND is_current = 1 AND lease_token = ${input.leaseToken}
              AND lease_until > ${input.now.toISOString()}
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const scope = yield* decodeGenerationScope(row.scope_json)
          const operationInput = yield* decodeStageOperationInput(row.input_json)
          const current = yield* isCurrentStageRevision(
            sql,
            scope.workflowId,
            scope.generation,
            operationInput.stageKey,
            operationInput.stageRevision,
          )
          if (!current) return "stale" as const
          yield* sql`
            UPDATE qrspi_stage_revisions
            SET prepared_result_json = ${JSON.stringify(output)}, state = 'publishing',
                updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND stage_key = ${operationInput.stageKey}
              AND revision = ${operationInput.stageRevision} AND state = 'producing'
          `
          yield* sql`
            UPDATE workflow_operations
            SET state = 'succeeded', output_json = ${JSON.stringify({
              preparedResult: output,
              sessionReferenceId: input.sessionReferenceId,
            })}, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId}
          `
          yield* sql`
            UPDATE workflow_operations SET state = 'ready', updated_at = ${input.now.toISOString()}
            WHERE kind = 'ArtifactPublish' AND is_current = 1 AND state = 'blocked'
              AND json_extract(input_json, '$.stageKey') = ${operationInput.stageKey}
              AND json_extract(input_json, '$.stageRevision') = ${operationInput.stageRevision}
              AND json_extract(scope_json, '$.workflowId') = ${scope.workflowId}
              AND json_extract(scope_json, '$.generation') = ${scope.generation}
          `
          return "completed" as const
        }),
      ),

    bindArtifactPublication: (input) =>
      transaction(
        Effect.gen(function* () {
          const artifact = yield* Schema.decodeUnknown(ArtifactReference)(input.artifact)
          if (artifact.commitSha !== input.finalSha) return "conflict" as const
          const existing = yield* sql<{ readonly external_intent_json: string | null }>`
            SELECT external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish' AND is_current = 1
          `
          const intent = existing[0]?.external_intent_json
          if (intent !== null && intent !== undefined) {
            const decoded = yield* Schema.decodeUnknown(
              Schema.parseJson(Schema.Struct({ finalSha: Schema.String })),
            )(intent)
            return decoded.finalSha === input.finalSha ? ("bound" as const) : ("conflict" as const)
          }
          const rows = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations
            SET state = 'waiting_external', external_intent_json = ${JSON.stringify({
              expectedOld: input.expectedOld,
              finalSha: input.finalSha,
              artifact,
            })}, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish'
              AND state = 'leased' AND is_current = 1 AND lease_token = ${input.leaseToken}
              AND lease_until > ${input.now.toISOString()}
            RETURNING operation_id
          `
          return rows.length === 1 ? ("bound" as const) : ("stale" as const)
        }),
      ),

    completeArtifactPublication: (input) =>
      transaction(
        Effect.gen(function* () {
          const artifact = yield* Schema.decodeUnknown(ArtifactReference)(input.artifact)
          if (input.observedHeadSha !== input.finalSha || artifact.commitSha !== input.finalSha) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "authoritative publication observation does not match the bound final SHA",
              }),
            )
          }
          const rows = yield* sql<{
            readonly scope_json: string
            readonly input_json: string
            readonly external_intent_json: string
          }>`
            SELECT scope_json, input_json, external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish'
              AND state = 'waiting_external' AND is_current = 1
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const intent = yield* Schema.decodeUnknown(
            Schema.parseJson(
              Schema.Struct({
                expectedOld: Schema.String,
                finalSha: Schema.String,
                artifact: ArtifactReference,
              }),
            ),
          )(row.external_intent_json)
          if (
            intent.expectedOld !== input.expectedOld ||
            intent.finalSha !== input.finalSha ||
            canonicalSha256(intent.artifact) !== canonicalSha256(artifact)
          ) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "publication completion conflicts with the durable final SHA binding",
              }),
            )
          }
          const scope = yield* decodeGenerationScope(row.scope_json)
          const operationInput = yield* decodeStageOperationInput(row.input_json)
          const current = yield* isCurrentStageRevision(
            sql,
            scope.workflowId,
            scope.generation,
            operationInput.stageKey,
            operationInput.stageRevision,
          )
          const cursors = yield* sql<{
            readonly current_head_sha: string
            readonly head_ref: string
          }>`
            SELECT current_head_sha, head_ref FROM qrspi_generations
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND is_current = 1 AND state = 'running'
          `
          if (!current || cursors[0]?.current_head_sha !== input.expectedOld)
            return "stale" as const

          const definitions = yield* sql<{ readonly definition_json: string }>`
            SELECT d.definition_json FROM qrspi_workflow_definitions d
            JOIN qrspi_generations g ON g.workflow_definition_sha256 = d.definition_sha256
            WHERE g.workflow_id = ${scope.workflowId} AND g.generation = ${scope.generation}
          `
          const definition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(
            definitions[0]?.definition_json ?? "null",
          )
          const stage = definition.stages.find(({ key }) => key === operationInput.stageKey)
          if (stage === undefined) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "stage is absent from the retained workflow definition",
              }),
            )
          }
          const accepted =
            stage.reviewPolicy.mode === "none" && stage.humanGatePolicy.mode !== "required"
          const nextState = accepted
            ? "succeeded"
            : stage.reviewPolicy.mode === "automated"
              ? "waiting_review"
              : "waiting_human"
          yield* sql`
            UPDATE workflow_operations
            SET state = 'succeeded', output_json = ${JSON.stringify({ artifact })},
                external_observation_json = ${JSON.stringify({
                  headRef: cursors[0].head_ref,
                  sha: input.observedHeadSha,
                })}, updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId}
          `
          yield* sql`
            UPDATE qrspi_stage_revisions
            SET state = ${accepted ? "accepted" : "reviewing"},
                published_reference_json = ${JSON.stringify(artifact)},
                updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND stage_key = ${operationInput.stageKey}
              AND revision = ${operationInput.stageRevision} AND state = 'publishing'
          `
          yield* sql`
            UPDATE qrspi_stage_runs
            SET state = ${nextState}, published_revision = ${operationInput.stageRevision},
                accepted_revision = ${accepted ? operationInput.stageRevision : null},
                pending_revision = ${accepted ? null : operationInput.stageRevision},
                updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND stage_key = ${operationInput.stageKey} AND state = 'active'
          `
          yield* sql`
            UPDATE qrspi_generations SET current_head_sha = ${input.finalSha},
              updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
          `
          if (!accepted) {
            yield* createStagePolicyGate(sql, {
              scope,
              stage,
              stageRevision: operationInput.stageRevision,
              workflowDefinitionSha256: operationInput.workflowDefinitionSha256,
              subject: artifact,
              now: input.now,
            })
          }
          if (accepted) {
            yield* activateNextStage(
              sql,
              definition,
              scope.workflowId,
              scope.generation,
              operationInput.stageKey,
              input.now,
            )
          }
          return "completed" as const
        }),
      ),

    acceptStagePolicy: (input) =>
      transaction(
        Effect.gen(function* () {
          const definitions = yield* sql<{ readonly definition_json: string }>`
            SELECT d.definition_json FROM qrspi_workflow_definitions d
            JOIN qrspi_generations g ON g.workflow_definition_sha256 = d.definition_sha256
            JOIN qrspi_stage_runs r ON r.workflow_id = g.workflow_id AND r.generation = g.generation
            WHERE r.workflow_id = ${input.workflowId} AND r.generation = ${input.generation}
              AND r.stage_key = ${input.stageKey} AND r.published_revision = ${input.stageRevision}
              AND r.pending_revision = ${input.stageRevision}
              AND r.state IN ('waiting_review', 'waiting_human')
              AND g.is_current = 1 AND g.state = 'running'
          `
          const json = definitions[0]?.definition_json
          if (json === undefined) return "stale" as const
          const definition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(json)
          yield* sql`
            UPDATE qrspi_stage_revisions SET state = 'accepted', updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${input.workflowId} AND generation = ${input.generation}
              AND stage_key = ${input.stageKey} AND revision = ${input.stageRevision}
              AND state IN ('reviewing', 'waiting_human')
          `
          yield* sql`
            UPDATE qrspi_stage_runs SET state = 'succeeded',
              accepted_revision = ${input.stageRevision}, pending_revision = NULL,
              updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${input.workflowId} AND generation = ${input.generation}
              AND stage_key = ${input.stageKey}
              AND state IN ('waiting_review', 'waiting_human')
          `
          yield* sql`
            UPDATE workflow_operation_gates SET state = 'answered'
            WHERE state = 'pending' AND operation_id IN (
              SELECT operation_id FROM workflow_operations
              WHERE json_extract(scope_json, '$.workflowId') = ${input.workflowId}
                AND json_extract(scope_json, '$.generation') = ${input.generation}
                AND json_extract(input_json, '$.stageKey') = ${input.stageKey}
                AND json_extract(input_json, '$.stageRevision') = ${input.stageRevision}
            )
          `
          yield* sql`
            UPDATE workflow_operations SET state = 'succeeded',
              output_json = ${JSON.stringify({ decision: "accepted" })},
              updated_at = ${input.now.toISOString()}
            WHERE kind IN ('ReviewSynthesize', 'GenericReviewHandoff') AND is_current = 1
              AND json_extract(scope_json, '$.workflowId') = ${input.workflowId}
              AND json_extract(scope_json, '$.generation') = ${input.generation}
              AND json_extract(input_json, '$.stageKey') = ${input.stageKey}
              AND json_extract(input_json, '$.stageRevision') = ${input.stageRevision}
              AND state IN ('ready', 'waiting_human')
          `
          yield* activateNextStage(
            sql,
            definition,
            input.workflowId,
            input.generation,
            input.stageKey,
            input.now,
          )
          return "completed" as const
        }),
      ),

    requestDocumentRevision: (input) =>
      transaction(
        Effect.gen(function* () {
          const sources = yield* Schema.decodeUnknown(Schema.Array(ArtifactReference))(
            input.acceptedSources,
          )
          const feedback = yield* Schema.decodeUnknown(
            Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_000))).pipe(
              Schema.maxItems(20),
            ),
          )(input.feedback ?? [])
          const rows = yield* sql<{
            readonly definition_json: string
            readonly workflow_definition_sha256: string
            readonly ticket_revision_sha256: string
            readonly source_artifacts_json: string
          }>`
            SELECT d.definition_json, g.workflow_definition_sha256, g.ticket_revision_sha256,
              v.source_artifacts_json
            FROM qrspi_stage_runs r
            JOIN qrspi_generations g ON g.workflow_id = r.workflow_id AND g.generation = r.generation
            JOIN qrspi_workflow_definitions d ON d.definition_sha256 = g.workflow_definition_sha256
            JOIN qrspi_stage_revisions v ON v.workflow_id = r.workflow_id
              AND v.generation = r.generation AND v.stage_key = r.stage_key
              AND v.revision = r.pending_revision
            WHERE r.workflow_id = ${input.workflowId} AND r.generation = ${input.generation}
              AND r.stage_key = ${input.stageKey} AND r.pending_revision = ${input.stageRevision}
              AND r.state IN ('waiting_review', 'waiting_human')
              AND v.revision_type = 'document' AND v.state IN ('reviewing', 'waiting_human')
              AND g.is_current = 1 AND g.state = 'running'
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const persistedSources = yield* Schema.decodeUnknown(
            Schema.parseJson(Schema.Array(ArtifactReference)),
          )(row.source_artifacts_json)
          if (canonicalSha256(sources) !== canonicalSha256(persistedSources))
            return "stale" as const
          const definition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(
            row.definition_json,
          )
          const stage = definition.stages.find(({ key }) => key === input.stageKey)
          if (stage === undefined || stage.kind !== "document") return "stale" as const
          if (
            stage.reviewPolicy.mode === "automated" &&
            input.stageRevision - 1 >= stage.reviewPolicy.maximumRevisions
          ) {
            const reason = "document revision budget exhausted; operator review required"
            yield* sql`
              UPDATE qrspi_stage_revisions SET state = 'waiting_human',
                updated_at = ${input.now.toISOString()}
              WHERE workflow_id = ${input.workflowId} AND generation = ${input.generation}
                AND stage_key = ${input.stageKey} AND revision = ${input.stageRevision}
                AND state IN ('reviewing', 'waiting_human')
            `
            yield* sql`
              UPDATE qrspi_stage_runs SET state = 'waiting_human',
                updated_at = ${input.now.toISOString()}
              WHERE workflow_id = ${input.workflowId} AND generation = ${input.generation}
                AND stage_key = ${input.stageKey} AND pending_revision = ${input.stageRevision}
                AND state IN ('waiting_review', 'waiting_human')
            `
            yield* sql`
              UPDATE workflow_operations SET state = 'waiting_human', last_error = ${reason},
                terminal_failure_reason = ${reason}, terminal_retry_policy = 'operator_required',
                updated_at = ${input.now.toISOString()}
              WHERE kind IN ('ReviewSynthesize', 'GenericReviewHandoff') AND is_current = 1
                AND json_extract(scope_json, '$.workflowId') = ${input.workflowId}
                AND json_extract(scope_json, '$.generation') = ${input.generation}
                AND json_extract(input_json, '$.stageKey') = ${input.stageKey}
                AND json_extract(input_json, '$.stageRevision') = ${input.stageRevision}
                AND state IN ('ready', 'waiting_human')
            `
            yield* sql`
              UPDATE workflow_operation_gates SET reason = ${reason}
              WHERE state = 'pending' AND operation_id IN (
                SELECT operation_id FROM workflow_operations
                WHERE json_extract(scope_json, '$.workflowId') = ${input.workflowId}
                  AND json_extract(scope_json, '$.generation') = ${input.generation}
                  AND json_extract(input_json, '$.stageKey') = ${input.stageKey}
                  AND json_extract(input_json, '$.stageRevision') = ${input.stageRevision}
              )
            `
            return "completed" as const
          }
          const nextRevision = input.stageRevision + 1
          yield* sql`
            UPDATE qrspi_stage_revisions SET state = 'abandoned', updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${input.workflowId} AND generation = ${input.generation}
              AND stage_key = ${input.stageKey} AND revision = ${input.stageRevision}
          `
          yield* sql`
            UPDATE workflow_operation_gates SET state = 'cancelled'
            WHERE state = 'pending' AND operation_id IN (
              SELECT operation_id FROM workflow_operations
              WHERE json_extract(scope_json, '$.workflowId') = ${input.workflowId}
                AND json_extract(scope_json, '$.generation') = ${input.generation}
                AND json_extract(input_json, '$.stageKey') = ${input.stageKey}
                AND json_extract(input_json, '$.stageRevision') = ${input.stageRevision}
            )
          `
          yield* sql`
            UPDATE workflow_operations SET state = 'superseded', is_current = 0,
              last_error = 'stage revision superseded', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, updated_at = ${input.now.toISOString()}
            WHERE is_current = 1
              AND json_extract(scope_json, '$.workflowId') = ${input.workflowId}
              AND json_extract(scope_json, '$.generation') = ${input.generation}
              AND json_extract(input_json, '$.stageKey') = ${input.stageKey}
              AND json_extract(input_json, '$.stageRevision') = ${input.stageRevision}
              AND state IN ('blocked', 'ready', 'leased', 'waiting_external', 'waiting_human')
          `
          yield* sql`
            INSERT INTO qrspi_stage_revisions (
              workflow_id, generation, stage_key, revision, revision_type,
              source_artifacts_json, state, created_at, updated_at
            ) VALUES (
              ${input.workflowId}, ${input.generation}, ${input.stageKey}, ${nextRevision},
              'document', ${JSON.stringify(sources)}, 'producing',
              ${input.now.toISOString()}, ${input.now.toISOString()}
            )
          `
          yield* sql`
            UPDATE qrspi_stage_runs SET state = 'active', pending_revision = ${nextRevision},
              updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${input.workflowId} AND generation = ${input.generation}
              AND stage_key = ${input.stageKey} AND pending_revision = ${input.stageRevision}
          `
          yield* createStageOperationPair(sql, {
            workflowId: input.workflowId,
            generation: input.generation,
            stage,
            stageRevision: nextRevision,
            workflowDefinitionSha256: row.workflow_definition_sha256,
            ticketRevisionSha256: row.ticket_revision_sha256,
            sources,
            feedback,
            now: input.now,
          })
          return "completed" as const
        }),
      ),

    bindImplementationPublication: (input) =>
      transaction(
        Effect.gen(function* () {
          const commit = yield* Schema.decodeUnknown(ImplementationCommitReference)(input.commit)
          const existing = yield* sql<{ readonly external_intent_json: string | null }>`
            SELECT external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish' AND is_current = 1
          `
          const intent = existing[0]?.external_intent_json
          if (intent !== null && intent !== undefined) {
            const decoded = yield* Schema.decodeUnknown(
              Schema.parseJson(Schema.Struct({ commit: ImplementationCommitReference })),
            )(intent)
            return decoded.commit.commitSha === commit.commitSha
              ? ("bound" as const)
              : ("conflict" as const)
          }
          const rows = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations
            SET state = 'waiting_external', external_intent_json = ${JSON.stringify({
              expectedOld: input.expectedOld,
              commit,
            })}, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish'
              AND state = 'leased' AND is_current = 1 AND lease_token = ${input.leaseToken}
              AND lease_until > ${input.now.toISOString()}
            RETURNING operation_id
          `
          return rows.length === 1 ? ("bound" as const) : ("stale" as const)
        }),
      ),

    completeImplementationPublication: (input) =>
      transaction(
        Effect.gen(function* () {
          const commit = yield* Schema.decodeUnknown(ImplementationCommitReference)(input.commit)
          if (
            input.observedHeadSha !== commit.commitSha ||
            commit.parentSha !== input.expectedOld
          ) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "authoritative implementation observation does not match commit",
              }),
            )
          }
          const rows = yield* sql<{
            readonly scope_json: string
            readonly input_json: string
            readonly external_intent_json: string
          }>`
            SELECT scope_json, input_json, external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'ArtifactPublish'
              AND state = 'waiting_external' AND is_current = 1
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const intent = yield* Schema.decodeUnknown(
            Schema.parseJson(
              Schema.Struct({ expectedOld: Schema.String, commit: ImplementationCommitReference }),
            ),
          )(row.external_intent_json)
          if (
            intent.expectedOld !== input.expectedOld ||
            canonicalSha256(intent.commit) !== canonicalSha256(commit)
          ) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "implementation completion conflicts with durable SHA binding",
              }),
            )
          }
          const scope = yield* decodeGenerationScope(row.scope_json)
          const operationInput = yield* decodeStageOperationInput(row.input_json)
          if (
            !(yield* isCurrentStageRevision(
              sql,
              scope.workflowId,
              scope.generation,
              operationInput.stageKey,
              operationInput.stageRevision,
            ))
          )
            return "stale" as const
          const cursor = yield* sql<{
            readonly current_head_sha: string
            readonly head_ref: string
          }>`
            SELECT current_head_sha, head_ref FROM qrspi_generations
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND is_current = 1 AND state = 'running'
          `
          if (cursor[0]?.current_head_sha !== input.expectedOld) return "stale" as const
          const prepared = yield* sql<{
            readonly prepared_result_json: string
            readonly definition_json: string
            readonly produce_operation_id: string
            readonly session_reference_id: string
            readonly existing_steps: number
            readonly ticket_revision_json: string
          }>`
            SELECT r.prepared_result_json, d.definition_json, t.revision_json AS ticket_revision_json,
              p.operation_id AS produce_operation_id,
              json_extract(p.output_json, '$.sessionReferenceId') AS session_reference_id,
              (SELECT count(*) FROM qrspi_implementation_steps s
                WHERE s.workflow_id = r.workflow_id AND s.generation = r.generation
                  AND s.stage_key = r.stage_key AND s.revision = r.revision) AS existing_steps
            FROM qrspi_stage_revisions r
            JOIN qrspi_generations g ON g.workflow_id = r.workflow_id AND g.generation = r.generation
            JOIN qrspi_workflow_definitions d ON d.definition_sha256 = g.workflow_definition_sha256
            JOIN qrspi_ticket_revisions t ON t.workflow_id = g.workflow_id
              AND t.ticket_revision_sha256 = g.ticket_revision_sha256
            JOIN workflow_operations p ON p.kind = 'StageProduce' AND p.state = 'succeeded'
              AND json_extract(p.scope_json, '$.workflowId') = r.workflow_id
              AND json_extract(p.scope_json, '$.generation') = r.generation
              AND json_extract(p.input_json, '$.stageKey') = r.stage_key
              AND json_extract(p.input_json, '$.stageRevision') = r.revision
              AND coalesce(json_extract(p.input_json, '$.stepPosition'), 1) =
                coalesce(json_extract(${row.input_json}, '$.stepPosition'), 1)
            WHERE r.workflow_id = ${scope.workflowId} AND r.generation = ${scope.generation}
              AND r.stage_key = ${operationInput.stageKey} AND r.revision = ${operationInput.stageRevision}
          `
          const preparedRow = prepared[0]
          if (preparedRow === undefined) return "stale" as const
          const definition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(
            preparedRow.definition_json,
          )
          const preparedResult = yield* Schema.decodeUnknown(
            Schema.parseJson(ImplementationStageResult),
          )(preparedRow.prepared_result_json)
          if (preparedResult.final && preparedResult.deliveryEvidence !== undefined) {
            const ticketRevision = yield* Schema.decodeUnknown(
              Schema.parseJson(Schema.Struct({ readyTicket: ReadyTicket })),
            )(preparedRow.ticket_revision_json)
            yield* Effect.try({
              try: () =>
                validatePreparedDeliveryEvidence(
                  ticketRevision.readyTicket,
                  preparedResult.deliveryEvidence!,
                ),
              catch: (cause) =>
                new WorkflowStartCurrentnessError({
                  operationId: input.operationId,
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
            })
          }
          const expectedPosition = Number(preparedRow.existing_steps) + 1
          if (commit.position !== expectedPosition) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "implementation commit position is not contiguous",
              }),
            )
          }
          yield* sql`
            INSERT INTO qrspi_implementation_steps (
              workflow_id, generation, stage_key, revision, position, produce_operation_id,
              publish_operation_id, session_reference_id, prepared_result_json,
              commit_reference_json, created_at
            ) VALUES (
              ${scope.workflowId}, ${scope.generation}, ${operationInput.stageKey},
              ${operationInput.stageRevision}, ${commit.position}, ${preparedRow.produce_operation_id},
              ${input.operationId}, ${preparedRow.session_reference_id}, ${preparedRow.prepared_result_json},
              ${JSON.stringify(commit)}, ${input.now.toISOString()}
            )
          `
          yield* sql`
            UPDATE workflow_operations SET state = 'succeeded',
              output_json = ${JSON.stringify(
                input.checkpoint === undefined ? { commit } : { checkpoint: input.checkpoint },
              )},
              external_observation_json = ${JSON.stringify({
                headRef: cursor[0].head_ref,
                sha: input.observedHeadSha,
              })}, updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId}
          `
          yield* sql`
            UPDATE qrspi_generations SET current_head_sha = ${commit.commitSha},
              updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
          `
          const stage = definition.stages.find(({ key }) => key === operationInput.stageKey)
          if (stage === undefined) return "stale" as const
          if (!preparedResult.final) {
            if (input.checkpoint !== undefined) {
              return yield* Effect.fail(
                new WorkflowStartCurrentnessError({
                  operationId: input.operationId,
                  reason: "non-final implementation step cannot include a checkpoint",
                }),
              )
            }
            yield* sql`
              UPDATE qrspi_stage_revisions SET state = 'producing', prepared_result_json = NULL,
                updated_at = ${input.now.toISOString()}
              WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
                AND stage_key = ${operationInput.stageKey} AND revision = ${operationInput.stageRevision}
                AND state = 'publishing'
            `
            yield* createStageOperationPair(sql, {
              workflowId: scope.workflowId,
              generation: scope.generation,
              stage,
              stageRevision: operationInput.stageRevision,
              workflowDefinitionSha256: operationInput.workflowDefinitionSha256,
              ticketRevisionSha256: operationInput.ticketRevisionSha256!,
              sources: operationInput.sources ?? [],
              stepPosition: expectedPosition + 1,
              now: input.now,
            })
          } else {
            if (preparedResult.deliveryEvidence === undefined || input.checkpoint === undefined) {
              return yield* Effect.fail(
                new WorkflowStartCurrentnessError({
                  operationId: input.operationId,
                  reason: "final implementation step requires delivery evidence and checkpoint",
                }),
              )
            }
            const checkpoint = yield* Schema.decodeUnknown(ImplementationCheckpointReference)(
              input.checkpoint,
            )
            const stepRows = yield* sql<{ readonly commit_reference_json: string }>`
              SELECT commit_reference_json FROM qrspi_implementation_steps
              WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
                AND stage_key = ${operationInput.stageKey} AND revision = ${operationInput.stageRevision}
              ORDER BY position
            `
            const commits = yield* Effect.forEach(stepRows, (step) =>
              Schema.decodeUnknown(Schema.parseJson(ImplementationCommitReference))(
                step.commit_reference_json,
              ),
            )
            const changedPaths = [...new Set(commits.flatMap((item) => item.changedPaths))]
            const contiguous = commits.every(
              (item, index) => index === 0 || item.parentSha === commits[index - 1]?.commitSha,
            )
            if (
              !contiguous ||
              canonicalSha256(checkpoint.commits) !== canonicalSha256(commits) ||
              canonicalSha256(checkpoint.changedPaths) !== canonicalSha256(changedPaths) ||
              checkpoint.workflowId !== scope.workflowId ||
              checkpoint.generation !== scope.generation ||
              checkpoint.stageKey !== operationInput.stageKey ||
              checkpoint.stageRevision !== operationInput.stageRevision ||
              checkpoint.baseSha !== commits[0]?.parentSha ||
              checkpoint.finalSha !== commit.commitSha ||
              checkpoint.preparedDeliveryEvidenceSha256 !==
                canonicalSha256(preparedResult.deliveryEvidence)
            ) {
              return yield* Effect.fail(
                new WorkflowStartCurrentnessError({
                  operationId: input.operationId,
                  reason: "implementation checkpoint does not cover contiguous persisted commits",
                }),
              )
            }
            const accepted =
              stage.reviewPolicy.mode === "none" && stage.humanGatePolicy.mode !== "required"
            yield* sql`
              UPDATE qrspi_stage_revisions SET state = ${accepted ? "accepted" : "reviewing"},
                published_reference_json = ${JSON.stringify(checkpoint)},
                updated_at = ${input.now.toISOString()}
              WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
                AND stage_key = ${operationInput.stageKey} AND revision = ${operationInput.stageRevision}
                AND state = 'publishing'
            `
            yield* sql`
              UPDATE qrspi_stage_runs SET state = ${
                accepted
                  ? "succeeded"
                  : stage.reviewPolicy.mode === "automated"
                    ? "waiting_review"
                    : "waiting_human"
              },
                published_revision = ${operationInput.stageRevision},
                accepted_revision = ${accepted ? operationInput.stageRevision : null},
                pending_revision = ${accepted ? null : operationInput.stageRevision},
                updated_at = ${input.now.toISOString()}
              WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
                AND stage_key = ${operationInput.stageKey} AND state = 'active'
            `
            if (accepted) {
              yield* activateNextStage(
                sql,
                definition,
                scope.workflowId,
                scope.generation,
                operationInput.stageKey,
                input.now,
              )
            } else {
              yield* createStagePolicyGate(sql, {
                scope,
                stage,
                stageRevision: operationInput.stageRevision,
                workflowDefinitionSha256: operationInput.workflowDefinitionSha256,
                subject: checkpoint,
                now: input.now,
              })
            }
          }
          return "completed" as const
        }),
      ),

    claimFinalizationOperation: (kind, workerId, leaseToken, leaseDurationMs, now) =>
      transaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE workflow_operations SET state = 'failed',
              last_error = 'retry budget exhausted after lease expiry',
              terminal_failure_reason = 'retry budget exhausted after lease expiry',
              terminal_retry_policy = 'retry_budget_exhausted', lease_owner = NULL,
              lease_token = NULL, lease_until = NULL, updated_at = ${now.toISOString()}
            WHERE kind = ${kind} AND is_current = 1 AND state = 'leased'
              AND lease_until <= ${now.toISOString()} AND attempt >= max_attempts
          `
          yield* sql`
            UPDATE qrspi_generations SET state = 'failed', updated_at = ${now.toISOString()}
            WHERE is_current = 1 AND state IN ('running', 'finalizing') AND EXISTS (
              SELECT 1 FROM workflow_operations o
              WHERE o.kind = ${kind} AND o.state = 'failed' AND o.is_current = 1
                AND o.updated_at = ${now.toISOString()}
                AND json_extract(o.scope_json, '$.workflowId') = qrspi_generations.workflow_id
                AND json_extract(o.scope_json, '$.generation') = qrspi_generations.generation
            )
          `
          const rows = yield* sql<{
            readonly operation_id: string
            readonly operation_revision: number
            readonly attempt: number
            readonly scope_json: string
            readonly input_json: string
            readonly repository_json: string
            readonly base_ref: string
            readonly head_ref: string
            readonly current_head_sha: string
          }>`
            UPDATE workflow_operations
            SET state = 'leased', attempt = attempt + 1, lease_owner = ${workerId},
              lease_token = ${leaseToken},
              lease_until = ${new Date(now.getTime() + leaseDurationMs).toISOString()},
              updated_at = ${now.toISOString()}
            WHERE operation_id = (
              SELECT o.operation_id FROM workflow_operations o
              JOIN qrspi_generations g
                ON g.workflow_id = json_extract(o.scope_json, '$.workflowId')
                AND g.generation = json_extract(o.scope_json, '$.generation')
              WHERE o.kind = ${kind} AND o.is_current = 1
                AND (o.state = 'ready' OR (o.state = 'leased' AND o.lease_until <= ${now.toISOString()}))
                AND o.run_at <= ${now.toISOString()} AND o.attempt < o.max_attempts
                AND g.is_current = 1
                AND g.state = ${kind === "PrePullRequestVerify" ? "running" : "finalizing"}
              ORDER BY o.run_at, o.operation_id LIMIT 1
            )
            RETURNING operation_id, operation_revision, attempt, scope_json, input_json,
              (SELECT repository_json FROM qrspi_generations g
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS repository_json,
              (SELECT base_ref FROM qrspi_generations g
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS base_ref,
              (SELECT head_ref FROM qrspi_generations g
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS head_ref,
              (SELECT current_head_sha FROM qrspi_generations g
                WHERE g.workflow_id = json_extract(scope_json, '$.workflowId')
                  AND g.generation = json_extract(scope_json, '$.generation')) AS current_head_sha
          `
          const row = rows[0]
          if (row === undefined) return null
          const scope = yield* decodeGenerationScope(row.scope_json)
          const operationInput = yield* Schema.decodeUnknown(
            Schema.parseJson(
              kind === "PrePullRequestVerify" ? PrePullRequestVerifyInput : PullRequestPublishInput,
            ),
          )(row.input_json)
          const repository = yield* Schema.decodeUnknown(Schema.parseJson(RepositoryReference))(
            row.repository_json,
          )
          return {
            operationId: row.operation_id,
            operationRevision: Number(row.operation_revision),
            attempt: Number(row.attempt),
            leaseToken,
            scope,
            kind,
            input: operationInput,
            repository,
            baseRef: row.base_ref,
            headRef: row.head_ref,
            currentHeadSha: row.current_head_sha,
          }
        }),
      ),

    findPullRequestPublicationRecovery: () =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly operation_id: string
          readonly operation_revision: number
          readonly attempt: number
          readonly scope_json: string
          readonly input_json: string
          readonly external_intent_json: string
          readonly external_observation_json: string | null
          readonly repository_json: string
          readonly base_ref: string
          readonly head_ref: string
          readonly current_head_sha: string
        }>`
          SELECT o.operation_id, o.operation_revision, o.attempt, o.scope_json, o.input_json,
            o.external_intent_json, o.external_observation_json, g.repository_json, g.base_ref,
            g.head_ref, g.current_head_sha
          FROM workflow_operations o JOIN qrspi_generations g
            ON g.workflow_id = json_extract(o.scope_json, '$.workflowId')
            AND g.generation = json_extract(o.scope_json, '$.generation')
          WHERE o.kind = 'PullRequestPublish' AND o.is_current = 1
            AND o.state = 'waiting_external' AND g.is_current = 1 AND g.state = 'finalizing'
          ORDER BY o.updated_at, o.operation_id LIMIT 1
        `
        const row = rows[0]
        if (row === undefined) return null
        return {
          operationId: row.operation_id,
          operationRevision: Number(row.operation_revision),
          attempt: Number(row.attempt),
          scope: yield* decodeGenerationScope(row.scope_json),
          kind: "PullRequestPublish" as const,
          input: yield* Schema.decodeUnknown(Schema.parseJson(PullRequestPublishInput))(
            row.input_json,
          ),
          intent: yield* Schema.decodeUnknown(Schema.parseJson(FinalPullRequestIntentSchema))(
            row.external_intent_json,
          ),
          ...(row.external_observation_json === null
            ? {}
            : {
                publicationReference: yield* Schema.decodeUnknown(
                  Schema.parseJson(
                    Schema.Struct({
                      reference: FinalPullRequestObservationSchema.fields.reference,
                    }),
                  ),
                )(row.external_observation_json).pipe(Effect.map(({ reference }) => reference)),
              }),
          repository: yield* Schema.decodeUnknown(Schema.parseJson(RepositoryReference))(
            row.repository_json,
          ),
          baseRef: row.base_ref,
          headRef: row.head_ref,
          currentHeadSha: row.current_head_sha,
        }
      }),

    completePrePullRequestVerification: (input) =>
      transaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly scope_json: string
            readonly input_json: string
            readonly repository_json: string
            readonly base_ref: string
            readonly head_ref: string
            readonly current_head_sha: string
            readonly prepared_result_json: string
            readonly published_reference_json: string
            readonly ticket_revision_json: string
          }>`
            SELECT o.scope_json, o.input_json, g.repository_json, g.base_ref, g.head_ref,
              g.current_head_sha, v.prepared_result_json, v.published_reference_json,
              t.revision_json AS ticket_revision_json
            FROM workflow_operations o JOIN qrspi_generations g
              ON g.workflow_id = json_extract(o.scope_json, '$.workflowId')
              AND g.generation = json_extract(o.scope_json, '$.generation')
            JOIN qrspi_stage_revisions v
              ON v.workflow_id = g.workflow_id AND v.generation = g.generation
              AND v.stage_key = json_extract(o.input_json, '$.checkpoint.stageKey')
              AND v.revision = json_extract(o.input_json, '$.checkpoint.stageRevision')
            JOIN qrspi_ticket_revisions t ON t.workflow_id = g.workflow_id
              AND t.ticket_revision_sha256 = g.ticket_revision_sha256
            WHERE o.operation_id = ${input.operationId} AND o.kind = 'PrePullRequestVerify'
              AND o.state = 'leased' AND o.is_current = 1 AND o.lease_token = ${input.leaseToken}
              AND o.lease_until > ${input.now.toISOString()}
              AND g.is_current = 1 AND g.state = 'running'
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const scope = yield* decodeGenerationScope(row.scope_json)
          const verification = yield* Schema.decodeUnknown(
            Schema.parseJson(PrePullRequestVerifyInput),
          )(row.input_json)
          const prepared = yield* Schema.decodeUnknown(Schema.parseJson(ImplementationStageResult))(
            row.prepared_result_json,
          )
          const acceptedCheckpoint = yield* Schema.decodeUnknown(
            Schema.parseJson(ImplementationCheckpointReference),
          )(row.published_reference_json)
          if (
            input.observedHeadSha !== row.current_head_sha ||
            verification.headSha !== row.current_head_sha ||
            verification.checkpoint.finalSha !== row.current_head_sha ||
            canonicalSha256(verification.checkpoint) !== canonicalSha256(acceptedCheckpoint) ||
            prepared.deliveryEvidence === undefined ||
            verification.preparedDeliveryEvidenceSha256 !==
              canonicalSha256(prepared.deliveryEvidence)
          ) {
            return "stale" as const
          }
          const ticketRevision = yield* Schema.decodeUnknown(
            Schema.parseJson(Schema.Struct({ readyTicket: ReadyTicket })),
          )(row.ticket_revision_json)
          const repository = yield* Schema.decodeUnknown(Schema.parseJson(RepositoryReference))(
            row.repository_json,
          )
          const evidenceLines = prepared.deliveryEvidence.scenarios.map(
            ({ scenario, evidence }) =>
              `- **${ticketRevision.readyTicket.scenarios[scenario]!.name}**: ${evidence}`,
          )
          const logical = `${scope.workflowId}:${scope.generation}:PullRequestPublish`
          const publicationOperationId = `${logical}:1`
          const marker = `<!-- workflowd-pull-request:${createHash("sha256").update(publicationOperationId).digest("hex")} -->`
          const body = [
            prepared.deliveryEvidence.summary,
            "",
            "## Delivery evidence",
            ...evidenceLines,
            "",
            marker,
          ].join("\n")
          const bodySha256 = createHash("sha256").update(body).digest("hex")
          const publishInput = {
            repository,
            baseRef: row.base_ref,
            headRef: row.head_ref,
            headSha: row.current_head_sha,
            title: ticketRevision.readyTicket.title,
            body,
            bodySha256,
            draft: false as const,
            checkpoint: verification.checkpoint,
            preparedDeliveryEvidence: prepared.deliveryEvidence,
            verificationOperationId: input.operationId,
          }
          yield* sql`
            UPDATE workflow_operations SET state = 'succeeded',
              output_json = ${JSON.stringify({
                checkpoint: verification.checkpoint,
                headSha: row.current_head_sha,
                verificationPolicySha256: canonicalSha256({
                  contractVersion: 1,
                  check: "branch-head",
                }),
                result: "passed",
                preparedDeliveryEvidenceSha256: verification.preparedDeliveryEvidenceSha256,
                completedAt: input.now.toISOString(),
              })}, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId}
          `
          yield* insertOperation(sql, {
            operationId: publicationOperationId,
            logicalOperationId: logical,
            revision: 1,
            retryOf: null,
            kind: "PullRequestPublish",
            scope,
            inputJson: JSON.stringify(publishInput),
            inputSha256: canonicalSha256(publishInput),
            state: "ready",
            attempt: 0,
            parentEffect: { success: "advance parent", failure: "fail Generation" },
            now: input.now,
          })
          yield* sql`
            UPDATE qrspi_generations SET state = 'finalizing', updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND is_current = 1 AND state = 'running'
          `
          return "verified" as const
        }),
      ),

    bindPullRequestPublication: (input) =>
      transaction(
        Effect.gen(function* () {
          const existing = yield* sql<{ readonly external_intent_json: string | null }>`
            SELECT external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'PullRequestPublish' AND is_current = 1
          `
          const bound = existing[0]?.external_intent_json
          if (bound !== null && bound !== undefined) {
            const decoded = yield* Schema.decodeUnknown(
              Schema.parseJson(FinalPullRequestIntentSchema),
            )(bound)
            return canonicalSha256(decoded) === canonicalSha256(input.intent)
              ? ("bound" as const)
              : ("conflict" as const)
          }
          const rows = yield* sql<{ readonly operation_id: string }>`
            UPDATE workflow_operations SET state = 'waiting_external',
              external_intent_json = ${JSON.stringify(input.intent)}, lease_owner = NULL,
              lease_token = NULL, lease_until = NULL, updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND kind = 'PullRequestPublish'
              AND state = 'leased' AND is_current = 1 AND lease_token = ${input.leaseToken}
              AND lease_until > ${input.now.toISOString()}
            RETURNING operation_id
          `
          return rows.length === 1 ? ("bound" as const) : ("stale" as const)
        }),
      ),

    bindPullRequestPublicationReference: (input) =>
      Effect.gen(function* () {
        const reference = yield* Schema.decodeUnknown(
          FinalPullRequestObservationSchema.fields.reference,
        )(input.reference)
        const rows = yield* sql<{ readonly operation_id: string }>`
          UPDATE workflow_operations
          SET external_observation_json = ${JSON.stringify({ reference })},
            updated_at = ${input.now.toISOString()}
          WHERE operation_id = ${input.operationId} AND kind = 'PullRequestPublish'
            AND state = 'waiting_external' AND is_current = 1
            AND external_observation_json IS NULL
          RETURNING operation_id
        `
        return rows.length === 1 ? ("bound" as const) : ("stale" as const)
      }),

    isFinalizationOperationCurrent: (operationId, now) =>
      sql<{ readonly operation_id: string }>`
        SELECT o.operation_id FROM workflow_operations o
        JOIN qrspi_generations g
          ON g.workflow_id = json_extract(o.scope_json, '$.workflowId')
          AND g.generation = json_extract(o.scope_json, '$.generation')
        WHERE o.operation_id = ${operationId} AND o.kind = 'PullRequestPublish'
          AND o.state = 'waiting_external' AND o.is_current = 1
          AND o.updated_at <= ${now.toISOString()}
          AND g.is_current = 1 AND g.state = 'finalizing'
          AND g.current_head_sha = json_extract(o.external_intent_json, '$.headSha')
      `.pipe(Effect.map((rows) => rows.length === 1)),

    completePullRequestPublication: (input) =>
      transaction(
        Effect.gen(function* () {
          const observation = yield* Schema.decodeUnknown(FinalPullRequestObservationSchema)(
            input.observation,
          )
          const rows = yield* sql<{
            readonly scope_json: string
            readonly input_json: string
            readonly external_intent_json: string
          }>`
            SELECT scope_json, input_json, external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'PullRequestPublish'
              AND state = 'waiting_external' AND is_current = 1
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const scope = yield* decodeGenerationScope(row.scope_json)
          const publication = yield* Schema.decodeUnknown(
            Schema.parseJson(PullRequestPublishInput),
          )(row.input_json)
          const intent = yield* Schema.decodeUnknown(
            Schema.parseJson(FinalPullRequestIntentSchema),
          )(row.external_intent_json)
          if (
            canonicalSha256(intent) !==
              canonicalSha256({
                repository: publication.repository,
                baseRef: publication.baseRef,
                headRef: publication.headRef,
                headSha: publication.headSha,
                title: publication.title,
                body: publication.body,
                bodySha256: publication.bodySha256,
                draft: publication.draft,
              }) ||
            observation.draft ||
            observation.state !== "open" ||
            observation.title !== intent.title ||
            canonicalSha256(observation.reference.repository) !==
              canonicalSha256(intent.repository) ||
            observation.headSha !== intent.headSha ||
            observation.headRef !== intent.headRef ||
            observation.baseRef !== intent.baseRef ||
            observation.bodySha256 !== intent.bodySha256
          ) {
            return "stale" as const
          }
          const generation = yield* sql<{ readonly workflow_id: string }>`
            UPDATE qrspi_generations SET state = 'completed', updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND is_current = 1 AND state = 'finalizing' AND current_head_sha = ${intent.headSha}
            RETURNING workflow_id
          `
          if (generation.length !== 1) return "stale" as const
          yield* sql`
            UPDATE workflow_operations SET state = 'succeeded',
              output_json = ${JSON.stringify({ pullRequest: observation })},
              external_observation_json = ${JSON.stringify(observation)},
              updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId}
          `
          const logical = `${scope.workflowId}:GenericReviewHandoff:${observation.reference.number}`
          const handoffInput = {
            pullRequest: observation,
            generation: scope.generation,
            checkpoint: publication.checkpoint,
          }
          yield* insertOperation(sql, {
            operationId: `${logical}:1`,
            logicalOperationId: logical,
            revision: 1,
            retryOf: null,
            kind: "GenericReviewHandoff",
            scope: { _tag: "WorkflowScope", workflowId: scope.workflowId },
            inputJson: JSON.stringify(handoffInput),
            inputSha256: canonicalSha256(handoffInput),
            state: "ready",
            attempt: 0,
            parentEffect: { success: "audit only", failure: "open operation-scoped gate" },
            now: input.now,
          })
          return "published" as const
        }),
      ),

    recordStalePullRequestPublicationEffect: (input) =>
      transaction(
        Effect.gen(function* () {
          const suppliedIntent = yield* Schema.decodeUnknown(FinalPullRequestIntentSchema)(
            input.intent,
          )
          const reference = yield* Schema.decodeUnknown(
            FinalPullRequestObservationSchema.fields.reference,
          )(input.reference)
          const observation =
            input.observation === undefined
              ? undefined
              : yield* Schema.decodeUnknown(FinalPullRequestObservationSchema)(input.observation)
          const rows = yield* sql<{
            readonly scope_json: string
            readonly external_intent_json: string
          }>`
            SELECT scope_json, external_intent_json FROM workflow_operations
            WHERE operation_id = ${input.operationId} AND kind = 'PullRequestPublish'
              AND state IN ('waiting_external', 'superseded')
          `
          const row = rows[0]
          if (row === undefined) return "stale" as const
          const intent = yield* Schema.decodeUnknown(
            Schema.parseJson(FinalPullRequestIntentSchema),
          )(row.external_intent_json)
          if (
            canonicalSha256(intent) !== canonicalSha256(suppliedIntent) ||
            canonicalSha256(reference.repository) !== canonicalSha256(intent.repository) ||
            (observation !== undefined &&
              canonicalSha256(observation.reference) !== canonicalSha256(reference))
          ) {
            return "stale" as const
          }
          const scope = yield* decodeGenerationScope(row.scope_json)
          yield* sql`
            UPDATE workflow_operations
            SET state = 'superseded', is_current = 0,
                external_observation_json = ${JSON.stringify({
                  reference,
                  ...(observation === undefined ? {} : { observation }),
                  outcome: "stale_effect",
                })}, last_error = 'pull request created after currentness was lost',
                lease_owner = NULL, lease_token = NULL, lease_until = NULL,
                updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND kind = 'PullRequestPublish'
              AND state IN ('waiting_external', 'superseded')
          `
          yield* sql`
            UPDATE qrspi_generations SET state = 'reconciling', updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND is_current = 1
              AND state NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'superseded')
          `
          const reconciliationIdentity = canonicalSha256({
            staleOperationId: input.operationId,
            pullRequest: reference,
          })
          const logical = `${scope.workflowId}:TargetReconcile:${reconciliationIdentity}`
          const existing = yield* sql<{ readonly operation_id: string }>`
            SELECT operation_id FROM workflow_operations
            WHERE logical_operation_id = ${logical} AND is_current = 1
          `
          if (existing.length === 0) {
            const reconciliationInput = {
              staleOperationId: input.operationId,
              generation: scope.generation,
              pullRequest: observation ?? { reference, intent },
            }
            yield* insertOperation(sql, {
              operationId: `${logical}:1`,
              logicalOperationId: logical,
              revision: 1,
              retryOf: null,
              kind: "TargetReconcile",
              scope: { _tag: "WorkflowScope", workflowId: scope.workflowId },
              inputJson: JSON.stringify(reconciliationInput),
              inputSha256: canonicalSha256(reconciliationInput),
              state: "ready",
              attempt: 0,
              parentEffect: { success: "audit only", failure: "open operation-scoped gate" },
              now: input.now,
            })
          }
          return "reconciling" as const
        }),
      ),

    rescheduleFinalizationOperation: (input) =>
      transaction(
        Effect.gen(function* () {
          const failed = yield* sql<{ readonly operation_id: string; readonly scope_json: string }>`
            UPDATE workflow_operations SET
              state = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'ready' END,
              last_error = ${input.error}, run_at = ${input.runAt.toISOString()},
              terminal_failure_reason = CASE WHEN attempt >= max_attempts THEN ${input.error} ELSE NULL END,
              terminal_retry_policy = CASE WHEN attempt >= max_attempts THEN 'retry_budget_exhausted' ELSE NULL END,
              lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              updated_at = ${input.now.toISOString()}
            WHERE operation_id = ${input.operationId} AND state = 'leased' AND is_current = 1
              AND lease_token = ${input.leaseToken}
            RETURNING operation_id, scope_json
          `
          const row = failed[0]
          if (row === undefined) return "stale" as const
          const state = yield* sql<{ readonly state: string }>`
            SELECT state FROM workflow_operations WHERE operation_id = ${input.operationId}
          `
          if (state[0]?.state !== "failed") return "rescheduled" as const
          const scope = yield* decodeGenerationScope(row.scope_json)
          yield* sql`
            UPDATE qrspi_generations SET state = 'failed', updated_at = ${input.now.toISOString()}
            WHERE workflow_id = ${scope.workflowId} AND generation = ${scope.generation}
              AND is_current = 1 AND state IN ('running', 'finalizing')
          `
          return "failed" as const
        }),
      ),
  }

  function decodeRow(raw: Record<string, unknown>) {
    const readableId = typeof raw.operation_id === "string" ? raw.operation_id : "unreadable"
    return Effect.gen(function* () {
      const row = yield* Schema.decodeUnknown(OperationRow)(raw).pipe(
        Effect.mapError((cause) => dataError("workflow_operation", readableId, cause)),
      )
      const [scope, operationInput] = yield* Effect.all([
        Schema.decodeUnknown(Schema.parseJson(WorkflowScope))(row.scope_json),
        Schema.decodeUnknown(Schema.parseJson(WorkflowStartInput))(row.input_json),
        Schema.decodeUnknown(JsonObjectText)(row.parent_effect_json),
        row.external_intent_json === null
          ? Effect.void
          : Schema.decodeUnknown(JsonObjectText)(row.external_intent_json),
        row.external_observation_json === null
          ? Effect.void
          : Schema.decodeUnknown(JsonObjectText)(row.external_observation_json),
      ]).pipe(Effect.mapError((cause) => dataError("workflow_operation", row.operation_id, cause)))
      const leased = row.state === "leased"
      const hasLease =
        row.lease_owner !== null && row.lease_token !== null && row.lease_until !== null
      if (
        row.kind !== "WorkflowStart" ||
        row.logical_operation_id !== `workflow-start:${scope.workflowId}` ||
        canonicalSha256(operationInput) !== row.input_sha256 ||
        leased !== hasLease ||
        (row.state === "waiting_external" && row.external_intent_json === null) ||
        (row.state === "succeeded") !== (row.output_json !== null)
      ) {
        return yield* Effect.fail(
          dataError("workflow_operation", row.operation_id, "persisted row invariants failed"),
        )
      }
      return row
    })
  }
}

function toStartRecord(row: OperationRow, branchName: string) {
  return Effect.gen(function* () {
    const output =
      row.output_json === null
        ? undefined
        : yield* decodeOutput(row.output_json).pipe(
            Effect.mapError((cause) => dataError("workflow_operation", row.operation_id, cause)),
          )
    const leaseUntil =
      row.lease_until === null
        ? undefined
        : yield* Schema.decodeUnknown(Schema.Date)(row.lease_until).pipe(
            Effect.mapError((cause) => dataError("workflow_operation", row.operation_id, cause)),
          )
    return yield* Schema.decodeUnknown(StartRecord)({
      operationId: row.operation_id,
      logicalOperationId: row.logical_operation_id,
      operationRevision: row.operation_revision,
      state: row.state,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
      ...(leaseUntil === undefined ? {} : { leaseUntil }),
      inputSha256: row.input_sha256,
      branchName,
      ...(output === undefined ? {} : { output }),
      ...(row.terminal_retry_policy === null
        ? {}
        : { terminalRetryPolicy: row.terminal_retry_policy }),
    }).pipe(Effect.mapError((cause) => dataError("workflow_operation", row.operation_id, cause)))
  })
}

const GenerationScope = Schema.Struct({
  _tag: Schema.Literal("GenerationScope"),
  workflowId: Schema.NonEmptyString,
  generation: Schema.Int.pipe(Schema.positive()),
})
const PrePullRequestVerifyInput = Schema.Struct({
  checkpoint: ImplementationCheckpointReference,
  headSha: Schema.String,
  preparedDeliveryEvidenceSha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
})
const FinalPullRequestIntentSchema = Schema.Struct({
  repository: RepositoryReference,
  baseRef: Schema.NonEmptyString,
  headRef: Schema.NonEmptyString,
  headSha: Schema.String,
  title: Schema.NonEmptyString,
  body: Schema.String,
  bodySha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  draft: Schema.Literal(false),
})
const PullRequestPublishInput = Schema.Struct({
  ...FinalPullRequestIntentSchema.fields,
  checkpoint: ImplementationCheckpointReference,
  preparedDeliveryEvidence: PreparedDeliveryEvidence,
  verificationOperationId: Schema.NonEmptyString,
})
const FinalPullRequestObservationSchema = Schema.Struct({
  reference: Schema.Struct({
    repository: RepositoryReference,
    number: Schema.Int.pipe(Schema.positive()),
  }),
  state: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  baseRef: Schema.NonEmptyString,
  headRef: Schema.NonEmptyString,
  headSha: Schema.String,
  draft: Schema.Boolean,
  body: Schema.String,
  bodySha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  url: Schema.NonEmptyString,
})
const StageOperationInput = Schema.Struct({
  stageKey: Schema.NonEmptyString,
  stageKind: Schema.Literal("document", "implementation"),
  stageRevision: Schema.Int.pipe(Schema.positive()),
  workflowDefinitionSha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  ticketRevisionSha256: Schema.optional(Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/))),
  sources: Schema.optional(Schema.Array(ArtifactReference).pipe(Schema.maxItems(32))),
  parameters: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  stepPosition: Schema.optional(Schema.Int.pipe(Schema.positive())),
  feedback: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_000))).pipe(
      Schema.maxItems(20),
    ),
  ),
})

const decodeGenerationScope = (json: string) =>
  Schema.decodeUnknown(Schema.parseJson(GenerationScope))(json)
const decodeStageOperationInput = (json: string) =>
  Schema.decodeUnknown(Schema.parseJson(StageOperationInput))(json)

function isCurrentStageRevision(
  sql: SqlClient.SqlClient,
  workflowId: string,
  generation: number,
  stageKey: string,
  revision: number,
) {
  return sql<{ readonly stage_key: string }>`
    SELECT r.stage_key FROM qrspi_stage_runs r
    JOIN qrspi_generations g
      ON g.workflow_id = r.workflow_id AND g.generation = r.generation
    WHERE r.workflow_id = ${workflowId} AND r.generation = ${generation}
      AND r.stage_key = ${stageKey} AND r.pending_revision = ${revision}
      AND r.state = 'active' AND g.is_current = 1 AND g.state = 'running'
  `.pipe(Effect.map((rows) => rows.length === 1))
}

function createStageOperationPair(
  sql: SqlClient.SqlClient,
  input: {
    readonly workflowId: string
    readonly generation: number
    readonly stage: StageDefinition
    readonly stageRevision: number
    readonly workflowDefinitionSha256: string
    readonly ticketRevisionSha256: string
    readonly sources: ReadonlyArray<typeof ArtifactReference.Type>
    readonly stepPosition?: number
    readonly feedback?: ReadonlyArray<string>
    readonly now: Date
  },
) {
  return Effect.gen(function* () {
    for (const initial of input.stage.initialOperations) {
      const stepSuffix = input.stepPosition === undefined ? "" : `:step:${input.stepPosition}`
      const logical = `${input.workflowId}:${input.generation}:${initial.kind}:${input.stage.key}:${input.stageRevision}${stepSuffix}`
      const childInput = {
        stageKey: input.stage.key,
        stageKind: input.stage.kind,
        stageRevision: input.stageRevision,
        workflowDefinitionSha256: input.workflowDefinitionSha256,
        ticketRevisionSha256: input.ticketRevisionSha256,
        sources: input.sources,
        ...(input.stepPosition === undefined ? {} : { stepPosition: input.stepPosition }),
        ...(input.feedback === undefined || input.feedback.length === 0
          ? {}
          : { feedback: input.feedback }),
        ...(initial.parameters === undefined ? {} : { parameters: initial.parameters }),
      }
      yield* insertOperation(sql, {
        operationId: `${logical}:1`,
        logicalOperationId: logical,
        revision: 1,
        retryOf: null,
        kind: initial.kind,
        scope: {
          _tag: "GenerationScope",
          workflowId: input.workflowId,
          generation: input.generation,
        },
        inputJson: JSON.stringify(childInput),
        inputSha256: canonicalSha256(childInput),
        state: initial.kind === "StageProduce" ? "ready" : "blocked",
        attempt: 0,
        maxAttempts: initial.kind === "StageProduce" ? input.stage.producer.retry.maxAttempts : 3,
        parentEffect: initial.parentEffect,
        now: input.now,
      })
    }
  })
}

function createStagePolicyGate(
  sql: SqlClient.SqlClient,
  input: {
    readonly scope: typeof GenerationScope.Type
    readonly stage: StageDefinition
    readonly stageRevision: number
    readonly workflowDefinitionSha256: string
    readonly subject: unknown
    readonly now: Date
  },
) {
  return Effect.gen(function* () {
    const policyKind =
      input.stage.reviewPolicy.mode === "automated"
        ? ("ReviewSynthesize" as const)
        : ("GenericReviewHandoff" as const)
    const logical = `${input.scope.workflowId}:${input.scope.generation}:${policyKind}:${input.stage.key}:${input.stageRevision}`
    const policyInput = {
      stageKey: input.stage.key,
      stageKind: input.stage.kind,
      stageRevision: input.stageRevision,
      workflowDefinitionSha256: input.workflowDefinitionSha256,
      subject: input.subject,
    }
    yield* insertOperation(sql, {
      operationId: `${logical}:1`,
      logicalOperationId: logical,
      revision: 1,
      retryOf: null,
      kind: policyKind,
      scope: input.scope,
      inputJson: JSON.stringify(policyInput),
      inputSha256: canonicalSha256(policyInput),
      state: "waiting_human",
      attempt: 0,
      parentEffect: { success: "advance parent", failure: "audit only" },
      now: input.now,
    })
    yield* sql`
      INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
      VALUES (
        ${`${logical}:1`}, 'pending',
        ${policyKind === "ReviewSynthesize" ? "automated review consumer unavailable; operator review required" : "stage approval required"},
        ${input.now.toISOString()}
      )
      ON CONFLICT (operation_id) DO NOTHING
    `
  })
}

function activateNextStage(
  sql: SqlClient.SqlClient,
  definition: WorkflowDefinition,
  workflowId: string,
  generation: number,
  completedStageKey: string,
  now: Date,
) {
  return Effect.gen(function* () {
    const currentRows = yield* sql<{ readonly stage_position: number }>`
      SELECT stage_position FROM qrspi_stage_runs
      WHERE workflow_id = ${workflowId} AND generation = ${generation}
        AND stage_key = ${completedStageKey}
    `
    const currentPosition = currentRows[0]?.stage_position
    if (currentPosition === undefined) return
    const nextRows = yield* sql<{ readonly stage_key: string }>`
      SELECT stage_key FROM qrspi_stage_runs
      WHERE workflow_id = ${workflowId} AND generation = ${generation}
        AND stage_position > ${currentPosition} AND state = 'blocked'
      ORDER BY stage_position LIMIT 1
    `
    const nextKey = nextRows[0]?.stage_key
    if (nextKey === undefined) {
      const stage = definition.stages.find(({ key }) => key === completedStageKey)
      if (stage?.kind === "document") {
        yield* sql`
          UPDATE qrspi_generations SET state = 'completed', updated_at = ${now.toISOString()}
          WHERE workflow_id = ${workflowId} AND generation = ${generation}
            AND is_current = 1 AND state = 'running'
        `
      } else if (stage?.kind === "implementation") {
        const checkpointRows = yield* sql<{
          readonly current_head_sha: string
          readonly published_reference_json: string
        }>`
          SELECT g.current_head_sha, v.published_reference_json
          FROM qrspi_generations g
          JOIN qrspi_stage_runs r
            ON r.workflow_id = g.workflow_id AND r.generation = g.generation
            AND r.stage_key = ${completedStageKey}
          JOIN qrspi_stage_revisions v
            ON v.workflow_id = r.workflow_id AND v.generation = r.generation
            AND v.stage_key = r.stage_key AND v.revision = r.accepted_revision
          WHERE g.workflow_id = ${workflowId} AND g.generation = ${generation}
            AND g.is_current = 1 AND g.state = 'running'
            AND r.state = 'succeeded' AND v.state = 'accepted'
            AND NOT EXISTS (
              SELECT 1 FROM qrspi_stage_runs pending
              WHERE pending.workflow_id = g.workflow_id AND pending.generation = g.generation
                AND pending.state NOT IN ('succeeded', 'skipped')
            )
            AND NOT EXISTS (
              SELECT 1 FROM workflow_operation_gates gate
              JOIN workflow_operations operation ON operation.operation_id = gate.operation_id
              WHERE gate.state = 'pending'
                AND json_extract(operation.scope_json, '$.workflowId') = g.workflow_id
                AND json_extract(operation.scope_json, '$.generation') = g.generation
            )
        `
        const checkpointRow = checkpointRows[0]
        if (checkpointRow === undefined) return
        const checkpoint = yield* Schema.decodeUnknown(
          Schema.parseJson(ImplementationCheckpointReference),
        )(checkpointRow.published_reference_json)
        if (checkpoint.finalSha !== checkpointRow.current_head_sha) return
        const logical = `${workflowId}:${generation}:PrePullRequestVerify`
        const verificationInput = {
          checkpoint,
          headSha: checkpointRow.current_head_sha,
          preparedDeliveryEvidenceSha256: checkpoint.preparedDeliveryEvidenceSha256,
        }
        yield* insertOperation(sql, {
          operationId: `${logical}:1`,
          logicalOperationId: logical,
          revision: 1,
          retryOf: null,
          kind: "PrePullRequestVerify",
          scope: { _tag: "GenerationScope", workflowId, generation },
          inputJson: JSON.stringify(verificationInput),
          inputSha256: canonicalSha256(verificationInput),
          state: "ready",
          attempt: 0,
          parentEffect: { success: "advance parent", failure: "fail Generation" },
          now,
        })
      }
      return
    }
    const stage = definition.stages.find(({ key }) => key === nextKey)
    if (stage === undefined) return
    const sourceRows = yield* sql<{ readonly published_reference_json: string }>`
      SELECT v.published_reference_json FROM qrspi_stage_revisions v
      JOIN qrspi_stage_runs r ON r.workflow_id = v.workflow_id AND r.generation = v.generation
        AND r.stage_key = v.stage_key AND r.accepted_revision = v.revision
      WHERE v.workflow_id = ${workflowId} AND v.generation = ${generation}
        AND v.published_reference_json IS NOT NULL
      ORDER BY r.stage_position
    `
    const sources = yield* Effect.forEach(sourceRows, (row) =>
      Schema.decodeUnknown(Schema.parseJson(ArtifactReference))(row.published_reference_json),
    )
    const generationRows = yield* sql<{
      readonly ticket_revision_sha256: string
      readonly workflow_definition_sha256: string
    }>`
      SELECT ticket_revision_sha256, workflow_definition_sha256 FROM qrspi_generations
      WHERE workflow_id = ${workflowId} AND generation = ${generation}
    `
    const generationRow = generationRows[0]
    if (generationRow === undefined) return
    yield* sql`
      UPDATE qrspi_stage_runs SET state = 'active', pending_revision = 1,
        updated_at = ${now.toISOString()}
      WHERE workflow_id = ${workflowId} AND generation = ${generation} AND stage_key = ${nextKey}
        AND state = 'blocked'
    `
    yield* sql`
      INSERT INTO qrspi_stage_revisions (
        workflow_id, generation, stage_key, revision, revision_type,
        source_artifacts_json, state, created_at, updated_at
      ) VALUES (
        ${workflowId}, ${generation}, ${nextKey}, 1, ${stage.kind},
        ${JSON.stringify(sources)}, 'producing', ${now.toISOString()}, ${now.toISOString()}
      )
    `
    for (const initial of stage.initialOperations) {
      const logical = `${workflowId}:${generation}:${initial.kind}:${stage.key}:1`
      const childInput = {
        stageKey: stage.key,
        stageKind: stage.kind,
        stageRevision: 1,
        workflowDefinitionSha256: generationRow.workflow_definition_sha256,
        ticketRevisionSha256: generationRow.ticket_revision_sha256,
        sources,
        ...(initial.parameters === undefined ? {} : { parameters: initial.parameters }),
      }
      yield* insertOperation(sql, {
        operationId: `${logical}:1`,
        logicalOperationId: logical,
        revision: 1,
        retryOf: null,
        kind: initial.kind,
        scope: { _tag: "GenerationScope", workflowId, generation },
        inputJson: JSON.stringify(childInput),
        inputSha256: canonicalSha256(childInput),
        state: initial.kind === "StageProduce" ? "ready" : "blocked",
        attempt: 0,
        maxAttempts: initial.kind === "StageProduce" ? stage.producer.retry.maxAttempts : 3,
        parentEffect: initial.parentEffect,
        now,
      })
    }
  })
}

type InsertOperationInput = {
  readonly operationId: string
  readonly logicalOperationId: string
  readonly revision: number
  readonly retryOf: string | null
  readonly kind:
    | "WorkflowStart"
    | "StageProduce"
    | "ArtifactPublish"
    | "ReviewSynthesize"
    | "GenericReviewHandoff"
    | "TargetReconcile"
    | "PrePullRequestVerify"
    | "PullRequestPublish"
  readonly scope: object
  readonly inputJson: string
  readonly inputSha256: string
  readonly state: "ready" | "blocked" | "leased" | "waiting_human"
  readonly attempt: number
  readonly maxAttempts?: number
  readonly leaseToken?: string
  readonly leaseUntil?: Date
  readonly parentEffect: object
  readonly now: Date
}

function insertOperation(sql: SqlClient.SqlClient, input: InsertOperationInput) {
  return sql`
    INSERT INTO workflow_operations (
      operation_id, logical_operation_id, operation_revision, retry_of, kind,
      scope_json, input_json, input_sha256, output_json, state, is_current,
      attempt, max_attempts, lease_owner, lease_token, lease_until, run_at,
      external_intent_json, external_observation_json, observation_attempts,
      max_observation_attempts, parent_effect_json, last_error, created_at, updated_at
    ) VALUES (
      ${input.operationId}, ${input.logicalOperationId}, ${input.revision}, ${input.retryOf},
      ${input.kind}, ${JSON.stringify(input.scope)}, ${input.inputJson}, ${input.inputSha256},
      NULL, ${input.state}, 1, ${input.attempt}, ${input.maxAttempts ?? 3},
       ${input.state === "leased" ? "workflow-start-ingress" : null},
      ${input.leaseToken ?? null}, ${input.leaseUntil?.toISOString() ?? null},
      ${input.now.toISOString()}, NULL, NULL, 0, 5, ${JSON.stringify(input.parentEffect)},
      NULL, ${input.now.toISOString()}, ${input.now.toISOString()}
    )
  `
}

export const QrspiStoreLive = Layer.effect(
  QrspiStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA busy_timeout = 5000`
    yield* runStoreMigrations
    return make(sql)
  }),
)

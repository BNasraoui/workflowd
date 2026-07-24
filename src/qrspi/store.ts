import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { runStoreMigrations } from "../store/migrations"
import {
  RepositoryReference,
  ExecutableStageSnapshot,
  StageDefinition,
  WorkflowDefinition,
  WorkflowStartInput,
  WorkflowStartOutput,
  TicketRevision,
  canonicalSha256,
  isEffectivelyEnabled,
  stageDefinitionSha256,
  ticketRevisionSha256For,
  workflowDefinitionSha256,
  type ExecutableStageSnapshot as ExecutableStageSnapshotType,
} from "./domain"
import { StageProduceInput, type StageProduceInput as StageProduceInputType } from "./contracts"

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
const LegacyWorkflowStartInput = Schema.Struct({
  contractVersion: Schema.Literal(1),
  repository: RepositoryReference,
  ticket: WorkflowStartInput.fields.ticket,
  ticketRevisionSha256: WorkflowStartInput.fields.ticketRevisionSha256,
  workflowDefinitionSha256: WorkflowStartInput.fields.workflowDefinitionSha256,
  baseRef: WorkflowStartInput.fields.baseRef,
  baseSha: WorkflowStartInput.fields.baseSha,
  branchName: WorkflowStartInput.fields.branchName,
})
const PersistedWorkflowStartInput = Schema.Union(WorkflowStartInput, LegacyWorkflowStartInput)
const decodeOutput = Schema.decodeUnknown(Schema.parseJson(WorkflowStartOutput))
const PersistedTicketRevision = Schema.Struct({
  ...TicketRevision.fields,
  checkedAt: Schema.DateFromString,
})
const TicketRevisionRow = Schema.Struct({
  workflow_id: Schema.NonEmptyString,
  ticket_revision_sha256: WorkflowStartInput.fields.ticketRevisionSha256,
  revision_json: Schema.String,
})
const StageProduceOperationRow = Schema.Struct({
  operation_id: Schema.NonEmptyString,
  kind: Schema.String,
  input_json: Schema.String,
  input_sha256: Schema.String,
})

const CurrentGenerationSnapshotRow = Schema.Struct({
  workflow_id: Schema.NonEmptyString,
  generation: Schema.Int.pipe(Schema.positive()),
  workflow_definition_sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  workflow_definition_json: Schema.NullOr(Schema.String),
  stage_definition_sha256: Schema.NullOr(Schema.String),
  stage_key: Schema.NullOr(Schema.String),
  sequence_position: Schema.NullOr(Schema.Number),
  definition_json: Schema.NullOr(Schema.String),
  contract_name: Schema.NullOr(Schema.String),
  contract_version: Schema.NullOr(Schema.Number),
  contract_registration_sha256: Schema.NullOr(Schema.String),
  harness_name: Schema.NullOr(Schema.String),
  harness_version: Schema.NullOr(Schema.Number),
  harness_registration_sha256: Schema.NullOr(Schema.String),
})

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
  readonly stageSnapshots: ReadonlyArray<ExecutableStageSnapshotType>
  readonly now: Date
}

export type WorkflowStartTerminalRetryPolicy = "retryable" | "operator_required"

export type CurrentGenerationSnapshotSet = {
  readonly workflowId: string
  readonly generation: number
  readonly workflowDefinitionSha256: string
  readonly snapshots: ReadonlyArray<ExecutableStageSnapshotType>
}

type StoreError =
  SqlError | QrspiStoreDataError | WorkflowStartCurrentnessError | WorkflowStartRetryExhaustedError

export type QrspiStorePort = {
  readonly loadCurrentGenerationSnapshotSets: () => Effect.Effect<
    ReadonlyArray<CurrentGenerationSnapshotSet>,
    SqlError | QrspiStoreDataError
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
  readonly readTicketRevision: (input: {
    readonly workflowId: string
    readonly ticketRevisionSha256: string
  }) => Effect.Effect<TicketRevision, SqlError | QrspiStoreDataError>
  readonly readStageProduceInput: (
    operationId: string,
  ) => Effect.Effect<StageProduceInputType, SqlError | QrspiStoreDataError>
}

export const QrspiStore = Context.GenericTag<QrspiStorePort>("workflowd/qrspi/QrspiStore")

export class QrspiStoreDataError extends Data.TaggedError("QrspiStoreDataError")<{
  readonly record:
    "workflow_operation" | "workflow_definition" | "stage_definition" | "ticket_revision"
  readonly recordId: string
  readonly message: string
  readonly reason?:
    "malformed" | "missing" | "duplicate" | "reordered" | "hash_mismatch" | "identity_mismatch"
  readonly workflowId?: string
  readonly generation?: number
  readonly sequencePosition?: number
  readonly expectedSha256?: string
  readonly actualSha256?: string
}> {}

export class WorkflowStartCurrentnessError extends Data.TaggedError(
  "WorkflowStartCurrentnessError",
)<{ readonly operationId: string; readonly reason: string }> {}

export class WorkflowStartRetryExhaustedError extends Data.TaggedError(
  "WorkflowStartRetryExhaustedError",
)<{ readonly operationId: string }> {}

type StoreDataErrorDetails = {
  readonly reason?: QrspiStoreDataError["reason"]
  readonly workflowId?: string
  readonly generation?: number
  readonly sequencePosition?: number
  readonly expectedSha256?: string
  readonly actualSha256?: string
}

const dataError = (
  record: QrspiStoreDataError["record"],
  recordId: string,
  cause: unknown,
  details: StoreDataErrorDetails = {},
) =>
  new QrspiStoreDataError({
    record,
    recordId,
    message: String(cause),
    ...(details.reason === undefined ? {} : { reason: details.reason }),
    ...(details.workflowId === undefined ? {} : { workflowId: details.workflowId }),
    ...(details.generation === undefined ? {} : { generation: details.generation }),
    ...(details.sequencePosition === undefined
      ? {}
      : { sequencePosition: details.sequencePosition }),
    ...(details.expectedSha256 === undefined ? {} : { expectedSha256: details.expectedSha256 }),
    ...(details.actualSha256 === undefined ? {} : { actualSha256: details.actualSha256 }),
  })

function decodeCurrentGenerationSnapshotSet(
  rows: ReadonlyArray<typeof CurrentGenerationSnapshotRow.Type>,
) {
  const first = rows[0]!
  const identity = {
    workflowId: first.workflow_id,
    generation: first.generation,
  }
  return Effect.gen(function* () {
    if (first.workflow_definition_json === null) {
      return yield* Effect.fail(
        dataError("workflow_definition", first.workflow_definition_sha256, "missing definition", {
          ...identity,
          reason: "missing",
        }),
      )
    }
    const workflowDefinition = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowDefinition))(
      first.workflow_definition_json,
    ).pipe(
      Effect.mapError((cause) =>
        dataError("workflow_definition", first.workflow_definition_sha256, cause, {
          ...identity,
          reason: "malformed",
        }),
      ),
    )
    const actualWorkflowSha256 = workflowDefinitionSha256(workflowDefinition)
    if (actualWorkflowSha256 !== first.workflow_definition_sha256) {
      return yield* Effect.fail(
        dataError("workflow_definition", first.workflow_definition_sha256, "hash mismatch", {
          ...identity,
          reason: "hash_mismatch",
          expectedSha256: first.workflow_definition_sha256,
          actualSha256: actualWorkflowSha256,
        }),
      )
    }
    if (rows.some((row) => row.stage_definition_sha256 === null)) {
      return yield* Effect.fail(
        dataError("stage_definition", first.workflow_definition_sha256, "missing snapshot set", {
          ...identity,
          reason: "missing",
        }),
      )
    }
    if (rows.length !== workflowDefinition.stages.length) {
      return yield* Effect.fail(
        dataError(
          "stage_definition",
          first.workflow_definition_sha256,
          "snapshot count does not match workflow definition",
          { ...identity, reason: rows.length === 0 ? "missing" : "identity_mismatch" },
        ),
      )
    }
    const seenPositions = new Set<number>()
    const seenKeys = new Set<string>()
    const snapshots = yield* Effect.forEach(
      rows,
      (row, index) =>
        Effect.gen(function* () {
          const recordId = row.stage_definition_sha256!
          const sequencePosition = row.sequence_position
          if (
            row.workflow_id !== first.workflow_id ||
            row.generation !== first.generation ||
            row.workflow_definition_sha256 !== first.workflow_definition_sha256 ||
            row.workflow_definition_json !== first.workflow_definition_json
          ) {
            return yield* Effect.fail(
              dataError("stage_definition", recordId, "generation identity changed within set", {
                ...identity,
                reason: "identity_mismatch",
              }),
            )
          }
          if (sequencePosition === null || !Number.isInteger(sequencePosition)) {
            return yield* Effect.fail(
              dataError("stage_definition", recordId, "malformed sequence position", {
                ...identity,
                reason: "malformed",
              }),
            )
          }
          if (
            seenPositions.has(sequencePosition) ||
            (row.stage_key !== null && seenKeys.has(row.stage_key))
          ) {
            return yield* Effect.fail(
              dataError("stage_definition", recordId, "duplicate snapshot identity", {
                ...identity,
                sequencePosition,
                reason: "duplicate",
              }),
            )
          }
          seenPositions.add(sequencePosition)
          if (row.stage_key !== null) seenKeys.add(row.stage_key)
          if (sequencePosition !== index + 1) {
            return yield* Effect.fail(
              dataError("stage_definition", recordId, "snapshot sequence is reordered", {
                ...identity,
                sequencePosition,
                reason: "reordered",
              }),
            )
          }
          const definition = yield* Schema.decodeUnknown(Schema.parseJson(StageDefinition))(
            row.definition_json,
          ).pipe(
            Effect.mapError((cause) =>
              dataError("stage_definition", recordId, cause, {
                ...identity,
                sequencePosition,
                reason: "malformed",
              }),
            ),
          )
          const snapshot = yield* Schema.decodeUnknown(ExecutableStageSnapshot)({
            sequencePosition,
            stageDefinitionSha256: recordId,
            definition,
            contractRegistrationSha256: row.contract_registration_sha256,
            harnessRegistrationSha256: row.harness_registration_sha256,
          }).pipe(
            Effect.mapError((cause) =>
              dataError("stage_definition", recordId, cause, {
                ...identity,
                sequencePosition,
                reason: "malformed",
              }),
            ),
          )
          const actualStageSha256 = stageDefinitionSha256(snapshot.definition)
          if (actualStageSha256 !== recordId) {
            return yield* Effect.fail(
              dataError("stage_definition", recordId, "hash mismatch", {
                ...identity,
                sequencePosition,
                reason: "hash_mismatch",
                expectedSha256: recordId,
                actualSha256: actualStageSha256,
              }),
            )
          }
          const configuredStage = workflowDefinition.stages[index]
          if (
            configuredStage === undefined ||
            row.stage_key !== definition.key ||
            row.contract_name !== definition.contract.name ||
            row.contract_version !== definition.contract.contractVersion ||
            row.harness_name !== definition.producer.harness.name ||
            row.harness_version !== definition.producer.harness.version ||
            canonicalSha256(configuredStage) !== canonicalSha256(definition)
          ) {
            return yield* Effect.fail(
              dataError("stage_definition", recordId, "snapshot columns do not match definition", {
                ...identity,
                sequencePosition,
                reason: "identity_mismatch",
              }),
            )
          }
          return snapshot
        }),
      { concurrency: 1 },
    )
    return {
      workflowId: first.workflow_id,
      generation: first.generation,
      workflowDefinitionSha256: first.workflow_definition_sha256,
      snapshots,
    } satisfies CurrentGenerationSnapshotSet
  })
}

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
    readStageProduceInput: (operationId) => {
      const read = Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT operation_id, kind, input_json, input_sha256
          FROM workflow_operations
          WHERE operation_id = ${operationId}
        `
        const raw = rows[0]
        if (raw === undefined) {
          return yield* Effect.fail(
            dataError("workflow_operation", operationId, "stage produce operation not found", {
              reason: "missing",
            }),
          )
        }
        const row = yield* Schema.decodeUnknown(StageProduceOperationRow)(raw).pipe(
          Effect.mapError((cause) =>
            dataError("workflow_operation", operationId, cause, { reason: "malformed" }),
          ),
        )
        if (row.kind !== "StageProduce") {
          return yield* Effect.fail(
            dataError("workflow_operation", operationId, "operation kind is not StageProduce", {
              reason: "identity_mismatch",
            }),
          )
        }
        const input = yield* Schema.decodeUnknown(Schema.parseJson(StageProduceInput), {
          onExcessProperty: "error",
        })(row.input_json).pipe(
          Effect.mapError((cause) =>
            dataError("workflow_operation", operationId, cause, { reason: "malformed" }),
          ),
        )
        const actualSha256 = canonicalSha256(input)
        if (actualSha256 !== row.input_sha256) {
          return yield* Effect.fail(
            dataError("workflow_operation", operationId, "operation input hash does not match", {
              reason: "hash_mismatch",
              expectedSha256: row.input_sha256,
              actualSha256,
            }),
          )
        }
        return input
      })
      return read.pipe(
        Effect.catchTag("QrspiStoreDataError", (error) =>
          error.reason === "identity_mismatch" ? Effect.fail(error) : quarantine(error),
        ),
      )
    },
    readTicketRevision: (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT workflow_id, ticket_revision_sha256, revision_json
          FROM qrspi_ticket_revisions
          WHERE workflow_id = ${input.workflowId}
            AND ticket_revision_sha256 = ${input.ticketRevisionSha256}
        `
        const raw = rows[0]
        const recordId = `${input.workflowId}/${input.ticketRevisionSha256}`
        if (raw === undefined) {
          return yield* Effect.fail(
            dataError("ticket_revision", recordId, "ticket revision not found", {
              reason: "missing",
              workflowId: input.workflowId,
            }),
          )
        }
        const row = yield* Schema.decodeUnknown(TicketRevisionRow)(raw).pipe(
          Effect.mapError((cause) =>
            dataError("ticket_revision", recordId, cause, {
              reason: "malformed",
              workflowId: input.workflowId,
            }),
          ),
        )
        const revision = yield* Schema.decodeUnknown(Schema.parseJson(PersistedTicketRevision))(
          row.revision_json,
        ).pipe(
          Effect.mapError((cause) =>
            dataError("ticket_revision", recordId, cause, {
              reason: "malformed",
              workflowId: input.workflowId,
            }),
          ),
        )
        if (revision.ticketRevisionSha256 !== row.ticket_revision_sha256) {
          return yield* Effect.fail(
            dataError("ticket_revision", recordId, "stored key does not match nested identity", {
              reason: "identity_mismatch",
              workflowId: input.workflowId,
              expectedSha256: row.ticket_revision_sha256,
              actualSha256: revision.ticketRevisionSha256,
            }),
          )
        }
        const actualSha256 = ticketRevisionSha256For(
          revision.readyTicket,
          revision.scenarioCoverage,
        )
        if (actualSha256 !== revision.ticketRevisionSha256) {
          return yield* Effect.fail(
            dataError("ticket_revision", recordId, "ticket semantic identity does not match", {
              reason: "hash_mismatch",
              workflowId: input.workflowId,
              expectedSha256: revision.ticketRevisionSha256,
              actualSha256,
            }),
          )
        }
        return revision
      }),
    loadCurrentGenerationSnapshotSets: () =>
      Effect.gen(function* () {
        const rawRows = yield* sql<Record<string, unknown>>`
          SELECT
            generation.workflow_id,
            generation.generation,
            generation.workflow_definition_sha256,
            workflow_definition.definition_json AS workflow_definition_json,
            stage.stage_definition_sha256,
            stage.stage_key,
            stage.sequence_position,
            stage.definition_json,
            stage.contract_name,
            stage.contract_version,
            stage.contract_registration_sha256,
            stage.harness_name,
            stage.harness_version,
            stage.harness_registration_sha256
          FROM qrspi_generations AS generation
          LEFT JOIN qrspi_workflow_definitions AS workflow_definition
            ON workflow_definition.definition_sha256 = generation.workflow_definition_sha256
          LEFT JOIN qrspi_stage_definitions AS stage
            ON stage.workflow_definition_sha256 = generation.workflow_definition_sha256
          WHERE generation.is_current = 1
            AND generation.generation_format = 'stage_snapshots_v1'
          ORDER BY generation.workflow_id, generation.generation, stage.sequence_position
        `
        const rows = yield* Effect.forEach(
          rawRows,
          (raw) =>
            Schema.decodeUnknown(CurrentGenerationSnapshotRow)(raw).pipe(
              Effect.mapError((cause) =>
                dataError(
                  "stage_definition",
                  typeof raw.workflow_id === "string" ? raw.workflow_id : "unreadable",
                  cause,
                  { reason: "malformed" },
                ),
              ),
            ),
          { concurrency: 1 },
        )
        const grouped = new Map<string, Array<typeof CurrentGenerationSnapshotRow.Type>>()
        for (const row of rows) {
          const key = `${row.workflow_id}\u0000${row.generation}`
          const group = grouped.get(key)
          if (group === undefined) grouped.set(key, [row])
          else group.push(row)
        }
        return yield* Effect.forEach(
          grouped.values(),
          (generationRows) => decodeCurrentGenerationSnapshotSet(generationRows),
          { concurrency: 1 },
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
          if (input.stageSnapshots.length !== definition.stages.length) {
            return yield* Effect.fail(
              dataError(
                "stage_definition",
                input.workflowDefinitionSha256,
                "snapshot count does not match workflow definition",
              ),
            )
          }
          const snapshots = yield* Effect.forEach(
            input.stageSnapshots,
            (suppliedSnapshot, index) =>
              Effect.gen(function* () {
                const snapshot = yield* Schema.decodeUnknown(ExecutableStageSnapshot)(
                  suppliedSnapshot,
                ).pipe(
                  Effect.mapError((cause) =>
                    dataError("stage_definition", suppliedSnapshot.stageDefinitionSha256, cause),
                  ),
                )
                const configuredStage = definition.stages[index]
                if (
                  configuredStage === undefined ||
                  snapshot.sequencePosition !== index + 1 ||
                  snapshot.stageDefinitionSha256 !== stageDefinitionSha256(snapshot.definition) ||
                  snapshot.definition.key !== configuredStage.key ||
                  canonicalSha256(snapshot.definition) !== canonicalSha256(configuredStage) ||
                  canonicalSha256(snapshot.definition.contract) !==
                    canonicalSha256(configuredStage.contract) ||
                  canonicalSha256(snapshot.definition.producer.harness) !==
                    canonicalSha256(configuredStage.producer.harness)
                ) {
                  return yield* Effect.fail(
                    dataError(
                      "stage_definition",
                      snapshot.stageDefinitionSha256,
                      "snapshot does not match workflow definition order",
                    ),
                  )
                }
                return snapshot
              }),
            { concurrency: 1 },
          )
          if (canonicalSha256(snapshots) !== persistedInput.stageSnapshotsSha256) {
            return yield* Effect.fail(
              new WorkflowStartCurrentnessError({
                operationId: input.operationId,
                reason: "supplied stage snapshots do not match persisted WorkflowStart input",
              }),
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
          for (const snapshot of snapshots) {
            const persisted = yield* sql<{ readonly stage_definition_sha256: string }>`
              INSERT INTO qrspi_stage_definitions (
                stage_definition_sha256, workflow_definition_sha256, stage_key,
                sequence_position, definition_json, contract_name, contract_version,
                contract_registration_sha256, harness_name, harness_version,
                harness_registration_sha256, created_at
              ) VALUES (
                ${snapshot.stageDefinitionSha256}, ${input.workflowDefinitionSha256},
                ${snapshot.definition.key}, ${snapshot.sequencePosition},
                ${JSON.stringify(snapshot.definition)}, ${snapshot.definition.contract.name},
                ${snapshot.definition.contract.contractVersion},
                ${snapshot.contractRegistrationSha256}, ${snapshot.definition.producer.harness.name},
                ${snapshot.definition.producer.harness.version},
                ${snapshot.harnessRegistrationSha256}, ${input.now.toISOString()}
              ) ON CONFLICT (workflow_definition_sha256, stage_definition_sha256) DO UPDATE SET
                stage_definition_sha256 = excluded.stage_definition_sha256
              WHERE qrspi_stage_definitions.stage_key = excluded.stage_key
                AND qrspi_stage_definitions.sequence_position = excluded.sequence_position
                AND qrspi_stage_definitions.definition_json = excluded.definition_json
                AND qrspi_stage_definitions.contract_name = excluded.contract_name
                AND qrspi_stage_definitions.contract_version = excluded.contract_version
                AND qrspi_stage_definitions.contract_registration_sha256 =
                  excluded.contract_registration_sha256
                AND qrspi_stage_definitions.harness_name = excluded.harness_name
                AND qrspi_stage_definitions.harness_version = excluded.harness_version
                AND qrspi_stage_definitions.harness_registration_sha256 =
                  excluded.harness_registration_sha256
              RETURNING stage_definition_sha256
            `
            if (persisted.length !== 1) {
              return yield* Effect.fail(
                dataError(
                  "stage_definition",
                  snapshot.stageDefinitionSha256,
                  "persisted snapshot association or registration identity does not match",
                  { reason: "identity_mismatch" },
                ),
              )
            }
          }
          yield* sql`
            INSERT INTO qrspi_generations (
              workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
              root_sha, current_head_sha, ticket_revision_sha256,
              workflow_definition_sha256, generation_format, state, is_current, created_at,
              updated_at
            ) VALUES (
              ${input.workflowId}, ${generation}, ${input.repositoryJson}, ${input.baseRef},
              ${input.baseSha}, ${input.branchName}, ${input.rootSha}, ${input.rootSha},
              ${input.ticketRevisionSha256}, ${input.workflowDefinitionSha256},
              'stage_snapshots_v1', 'running', 1, ${input.now.toISOString()},
              ${input.now.toISOString()}
            )
          `
          const firstStage = snapshots.find(({ definition: stage }) =>
            isEffectivelyEnabled(stage),
          )?.definition
          if (firstStage !== undefined) {
            const initialOperations = [
              {
                kind: "StageProduce" as const,
                state: "ready" as const,
                maxAttempts: firstStage.producer.retry.maxAttempts,
              },
              {
                kind: "ArtifactPublish" as const,
                state: "blocked" as const,
                maxAttempts: 3,
              },
            ]
            for (const initial of initialOperations) {
              const logical = `${input.workflowId}:${generation}:${initial.kind}:${firstStage.key}:1`
              const childInput = {
                stageKey: firstStage.key,
                stageKind: firstStage.kind,
                stageRevision: 1,
                workflowDefinitionSha256: input.workflowDefinitionSha256,
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
                maxAttempts: initial.maxAttempts,
                parentEffect: { success: "advance parent", failure: "fail Generation" },
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
  }

  function decodeRow(raw: Record<string, unknown>) {
    const readableId = typeof raw.operation_id === "string" ? raw.operation_id : "unreadable"
    return Effect.gen(function* () {
      const row = yield* Schema.decodeUnknown(OperationRow)(raw).pipe(
        Effect.mapError((cause) => dataError("workflow_operation", readableId, cause)),
      )
      const [scope, operationInput] = yield* Effect.all([
        Schema.decodeUnknown(Schema.parseJson(WorkflowScope))(row.scope_json),
        Schema.decodeUnknown(Schema.parseJson(PersistedWorkflowStartInput))(row.input_json),
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

type InsertOperationInput = {
  readonly operationId: string
  readonly logicalOperationId: string
  readonly revision: number
  readonly retryOf: string | null
  readonly kind: "WorkflowStart" | "StageProduce" | "ArtifactPublish" | "TargetReconcile"
  readonly scope: object
  readonly inputJson: string
  readonly inputSha256: string
  readonly state: "ready" | "blocked" | "leased"
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

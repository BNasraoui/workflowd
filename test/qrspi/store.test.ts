import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Effect, Layer } from "effect"
import { canonicalSha256 } from "../../src/qrspi/domain"
import {
  QrspiStore,
  QrspiStoreLive,
  preflightDocumentStageRevisionAggregate,
  type QrspiStorePort,
} from "../../src/qrspi/store"
import type { DocumentStageRevisionAggregate } from "../../src/qrspi/stage-runtime"

const sha = (character: string) => character.repeat(64)
const repository = {
  providerInstanceId: "github-app-1",
  repositoryId: "repository-1",
  repositoryFullName: "owner/repository",
}
const now = new Date("2026-07-25T12:34:56.789Z")
const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function documentAggregate(): DocumentStageRevisionAggregate {
  const sources = {
    workflowId: "workflow-1",
    generation: 1,
    stageKey: "plan",
    runOrdinal: 2,
    stageRevision: 3,
    workflowDefinitionSha256: sha("a"),
    stageDefinitionSha256: sha("b"),
    ticketRevision: {
      workflowId: "workflow-1",
      ticketRevisionSha256: sha("c"),
    },
    sources: [],
    sourceSetSha256: canonicalSha256([]),
    target: {
      repository,
      headRef: "refs/heads/workflow",
      expectedParentSha: "d".repeat(40),
    },
  }
  const revision = {
    workflowId: sources.workflowId,
    generation: sources.generation,
    stageKey: sources.stageKey,
    runOrdinal: sources.runOrdinal,
    stageRevision: sources.stageRevision,
  }
  const preparedValue = { _tag: "Document" as const, text: "# Plan" }

  return {
    kind: "document",
    sources,
    runState: "waiting_review",
    isCurrent: true,
    activationPolicy: {
      mode: "conditional",
      policy: { name: "qrspi.stage-activation", version: 1 },
      decision: "enabled",
      reason: "The stage is selected for this generation",
    },
    revisionState: "reviewing",
    ownerCrossingKey: "plan-publication",
    pendingRevision: revision,
    publishedRevision: revision,
    acceptedRevision: revision,
    preparedResult: {
      value: preparedValue,
      sha256: canonicalSha256(preparedValue),
    },
    finalArtifact: {
      repository,
      workflowId: sources.workflowId,
      generation: sources.generation,
      stageKey: sources.stageKey,
      stageRevision: sources.stageRevision,
      commitSha: "e".repeat(40),
      path: "artifacts/plan.md",
      blobSha: "f".repeat(40),
      contentSha256: sha("1"),
      mediaType: "text/markdown",
    },
    producerOperationId: "operation-produce-1",
    publicationOperationId: "operation-publish-1",
  }
}

const preflightFailure = (input: unknown) =>
  Effect.runPromise(preflightDocumentStageRevisionAggregate(input).pipe(Effect.either))

type AggregateOperation = {
  readonly operationId: string
  readonly kind: "StageProduce" | "ArtifactPublish"
  readonly scope: unknown
  readonly input: Record<string, unknown>
  readonly inputSha256: string
}

const exactScope = (aggregate: DocumentStageRevisionAggregate) => ({
  workflowId: aggregate.sources.workflowId,
  generation: aggregate.sources.generation,
  stageKey: aggregate.sources.stageKey,
  runOrdinal: aggregate.sources.runOrdinal,
  stageRevision: aggregate.sources.stageRevision,
  workflowDefinitionSha256: aggregate.sources.workflowDefinitionSha256,
  stageDefinitionSha256: aggregate.sources.stageDefinitionSha256,
})

const producerInput = (
  aggregate: DocumentStageRevisionAggregate,
  sources: DocumentStageRevisionAggregate["sources"] = aggregate.sources,
) => {
  const request = { _tag: "PlanRequest", sources }
  return {
    contractVersion: 1,
    scope: exactScope({ ...aggregate, sources }),
    contract: { name: "qrspi.plan", contractVersion: 1 },
    request,
    requestSha256: canonicalSha256(request),
  }
}

const publicationInput = (aggregate: DocumentStageRevisionAggregate) => ({
  scope: exactScope(aggregate),
  publicationReceipt: { provider: "github", requestId: "publish-request-1" },
  requestedPath: "artifacts/plan.md",
})

const operation = (
  operationId: string,
  kind: AggregateOperation["kind"],
  scope: unknown,
  input: Record<string, unknown>,
  inputSha256 = canonicalSha256(input),
): AggregateOperation => ({ operationId, kind, scope, input, inputSha256 })

const validOperations = (aggregate: DocumentStageRevisionAggregate) => [
  operation(
    aggregate.producerOperationId,
    "StageProduce",
    {
      _tag: "GenerationScope",
      workflowId: aggregate.sources.workflowId,
      generation: aggregate.sources.generation,
    },
    producerInput(aggregate),
  ),
  operation(
    aggregate.publicationOperationId,
    "ArtifactPublish",
    {
      _tag: "GenerationScope",
      workflowId: aggregate.sources.workflowId,
      generation: aggregate.sources.generation,
    },
    publicationInput(aggregate),
  ),
]

function insertAggregateOperation(sql: SqlClient.SqlClient, row: AggregateOperation) {
  const timestamp = "2026-07-25T01:02:03.000Z"
  return sql`
    INSERT INTO workflow_operations (
      operation_id, logical_operation_id, operation_revision, retry_of, kind,
      scope_json, input_json, input_sha256, output_json, state, is_current,
      attempt, max_attempts, lease_owner, lease_token, lease_until, run_at,
      external_intent_json, external_observation_json, observation_attempts,
      max_observation_attempts, parent_effect_json, last_error,
      terminal_failure_reason, terminal_retry_policy, created_at, updated_at
    ) VALUES (
      ${row.operationId}, ${row.operationId}, 1, NULL, ${row.kind},
      ${JSON.stringify(row.scope)}, ${JSON.stringify(row.input)}, ${row.inputSha256}, NULL,
      'ready', 1, 0, 3, NULL, NULL, NULL, ${timestamp}, NULL, NULL, 0, 5,
      '{}', NULL, NULL, NULL, ${timestamp}, ${timestamp}
    )
  `
}

const seedAggregatePrerequisites = (
  sql: SqlClient.SqlClient,
  aggregate: DocumentStageRevisionAggregate,
  operations: ReadonlyArray<AggregateOperation>,
) =>
  Effect.gen(function* () {
    const timestamp = "2026-07-25T01:02:03.000Z"
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`
      INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
      VALUES (${aggregate.sources.workflowId}, 'workflow/plan', ${timestamp}, ${timestamp})
    `
    yield* sql`
      INSERT INTO qrspi_ticket_revisions (
        workflow_id, ticket_revision_sha256, revision_json, checked_at
      ) VALUES (
        ${aggregate.sources.workflowId}, ${aggregate.sources.ticketRevision.ticketRevisionSha256},
        '{"ticket":"plan"}', ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_workflow_definitions (definition_sha256, definition_json, created_at)
      VALUES (${aggregate.sources.workflowDefinitionSha256}, '{"workflow":"plan"}', ${timestamp})
    `
    yield* sql`
      INSERT INTO qrspi_stage_definitions (
        stage_definition_sha256, workflow_definition_sha256, stage_key,
        sequence_position, definition_json, contract_name, contract_version,
        contract_registration_sha256, harness_name, harness_version,
        harness_registration_sha256, created_at
      ) VALUES (
        ${aggregate.sources.stageDefinitionSha256},
        ${aggregate.sources.workflowDefinitionSha256}, ${aggregate.sources.stageKey}, 1,
        '{"kind":"document"}', 'qrspi.plan', 1, ${sha("7")}, 'opencode', 1,
        ${sha("8")}, ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_generations (
        workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
        root_sha, current_head_sha, ticket_revision_sha256,
        workflow_definition_sha256, state, is_current, created_at, updated_at,
        generation_format, current_stage_key, current_stage_run_ordinal
      ) VALUES (
        ${aggregate.sources.workflowId}, ${aggregate.sources.generation},
        ${JSON.stringify(repository)}, 'main', ${"2".repeat(40)},
        ${aggregate.sources.target.headRef}, ${"3".repeat(40)}, ${"4".repeat(40)},
        ${aggregate.sources.ticketRevision.ticketRevisionSha256},
        ${aggregate.sources.workflowDefinitionSha256}, 'running', 1,
        ${timestamp}, ${timestamp}, 'stage_runtime_v1', NULL, NULL
      )
    `
    for (const row of operations) yield* insertAggregateOperation(sql, row)
  })

const expectNoDocumentAggregateRows = (
  sql: SqlClient.SqlClient,
  aggregate: DocumentStageRevisionAggregate,
) =>
  Effect.gen(function* () {
    const identity = sql`
      workflow_id = ${aggregate.sources.workflowId}
      AND generation = ${aggregate.sources.generation}
      AND stage_key = ${aggregate.sources.stageKey}
    `
    const [runs, revisions, documents, artifacts, commonOwners, documentOwners] = yield* Effect.all(
      [
        sql<{
          readonly count: number
        }>`SELECT count(*) AS count FROM qrspi_stage_runs WHERE ${identity}`,
        sql<{
          readonly count: number
        }>`SELECT count(*) AS count FROM qrspi_stage_revisions WHERE ${identity}`,
        sql<{
          readonly count: number
        }>`SELECT count(*) AS count FROM qrspi_document_stage_revisions WHERE ${identity}`,
        sql<{
          readonly count: number
        }>`SELECT count(*) AS count FROM qrspi_artifact_references WHERE ${identity}`,
        sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM qrspi_stage_operation_owners
          WHERE operation_id IN (
            ${aggregate.producerOperationId}, ${aggregate.publicationOperationId}
          )
        `,
        sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM qrspi_document_stage_revision_operations WHERE ${identity}
        `,
      ],
    )
    expect([runs, revisions, documents, artifacts, commonOwners, documentOwners]).toEqual(
      Array.from({ length: 6 }, () => [{ count: 0 }]),
    )
  })

async function aggregateFixture<A>(
  body: (context: {
    readonly sql: SqlClient.SqlClient
    readonly store: QrspiStorePort
    readonly aggregate: DocumentStageRevisionAggregate
  }) => Effect.Effect<A, unknown>,
  aggregate: DocumentStageRevisionAggregate = documentAggregate(),
) {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-document-aggregate-"))
  directories.push(directory)
  const storeLayer = QrspiStoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(directory, "workflowd.db") })),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* QrspiStore
      return yield* body({ sql, store, aggregate })
    }).pipe(Effect.provide(storeLayer)),
  )
}

const expectAggregateCreateFailure = (
  sql: SqlClient.SqlClient,
  store: QrspiStorePort,
  aggregate: DocumentStageRevisionAggregate,
  operations: ReadonlyArray<AggregateOperation>,
  expected: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    yield* seedAggregatePrerequisites(sql, aggregate, operations)
    const result = yield* store
      .createDocumentStageRuntimeAggregate(aggregate, now)
      .pipe(Effect.either)
    expect(result).toMatchObject({
      _tag: "Left",
      left: { record: "workflow_operation", ...expected },
    })
    yield* expectNoDocumentAggregateRows(sql, aggregate)
  })

test("accepts one exact document aggregate", async () => {
  const aggregate = documentAggregate()

  await expect(
    Effect.runPromise(preflightDocumentStageRevisionAggregate(aggregate)),
  ).resolves.toEqual(aggregate)
  expect(aggregate.isCurrent).toBe(true)
  expect(aggregate.activationPolicy).toEqual({
    mode: "conditional",
    policy: { name: "qrspi.stage-activation", version: 1 },
    decision: "enabled",
    reason: "The stage is selected for this generation",
  })
})

test("rejects a malformed aggregate tag", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({ ...aggregate, kind: "implementation" })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "malformed",
    },
  })
})

test("rejects an unhashable prepared Document as malformed", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    preparedResult: {
      value: { _tag: "Document", text: "\ud800" },
      sha256: sha("2"),
    },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "QrspiStoreDataError", reason: "malformed" },
  })
})

test("bounds malformed structural diagnostics", async () => {
  const result = await preflightFailure({
    ...documentAggregate(),
    rejected: "x".repeat(10_000),
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "QrspiStoreDataError", reason: "malformed" },
  })
  if (result._tag === "Left") {
    expect(result.left.message.length).toBeGreaterThan(0)
    expect(result.left.message.length).toBeLessThanOrEqual(2_000)
  }
})

test("rejects a guarded pointer from another run", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    pendingRevision: {
      ...aggregate.pendingRevision!,
      runOrdinal: aggregate.sources.runOrdinal + 1,
    },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "identity_mismatch",
      expectedIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        runOrdinal: aggregate.sources.runOrdinal,
      },
      actualIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        runOrdinal: aggregate.sources.runOrdinal + 1,
      },
    },
  })
})

test("rejects a guarded pointer to another revision in the same run", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    pendingRevision: {
      ...aggregate.pendingRevision!,
      stageRevision: aggregate.sources.stageRevision + 1,
    },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "identity_mismatch",
      expectedIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        runOrdinal: aggregate.sources.runOrdinal,
        stageRevision: aggregate.sources.stageRevision,
      },
      actualIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        runOrdinal: aggregate.sources.runOrdinal,
        stageRevision: aggregate.sources.stageRevision + 1,
      },
    },
  })
})

test("rejects a final artifact from another stage revision", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    finalArtifact: {
      ...aggregate.finalArtifact!,
      stageRevision: aggregate.sources.stageRevision + 1,
    },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "identity_mismatch",
      expectedIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        stageRevision: aggregate.sources.stageRevision,
        repository,
      },
      actualIdentity: {
        workflowId: aggregate.sources.workflowId,
        generation: aggregate.sources.generation,
        stageKey: aggregate.sources.stageKey,
        stageRevision: aggregate.sources.stageRevision + 1,
        repository,
      },
    },
  })
})

test("rejects equal producer and publication operation IDs", async () => {
  const aggregate = documentAggregate()
  const result = await preflightFailure({
    ...aggregate,
    publicationOperationId: aggregate.producerOperationId,
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "duplicate",
    },
  })
})

test("rejects a prepared Document with the wrong canonical hash", async () => {
  const aggregate = documentAggregate()
  const expectedSha256 = canonicalSha256(aggregate.preparedResult!.value)
  const result = await preflightFailure({
    ...aggregate,
    preparedResult: { ...aggregate.preparedResult!, sha256: sha("2") },
  })

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QrspiStoreDataError",
      record: "document_stage_revision_aggregate",
      reason: "hash_mismatch",
      expectedSha256,
      actualSha256: sha("2"),
    },
  })
})

describe("document aggregate operation authority", () => {
  test("rejects a missing aggregate operation before writing runtime rows", async () => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      expectAggregateCreateFailure(sql, store, aggregate, [validOperations(aggregate)[0]!], {
        _tag: "QrspiStoreDataError",
        recordId: aggregate.publicationOperationId,
        reason: "missing",
      }),
    )
  })

  test.each([
    {
      name: "strict producer input",
      select: (aggregate: DocumentStageRevisionAggregate) => {
        const [producer, publication] = validOperations(aggregate)
        const input = { ...producer!.input, unexpected: true }
        return [{ ...producer!, input, inputSha256: canonicalSha256(input) }, publication!] as const
      },
      operationId: (aggregate: DocumentStageRevisionAggregate) => aggregate.producerOperationId,
    },
    {
      name: "publication scope projection",
      select: (aggregate: DocumentStageRevisionAggregate) => {
        const [producer, publication] = validOperations(aggregate)
        const input = { publicationReceipt: { requestId: "publish-request-1" } }
        return [producer!, { ...publication!, input, inputSha256: canonicalSha256(input) }] as const
      },
      operationId: (aggregate: DocumentStageRevisionAggregate) => aggregate.publicationOperationId,
    },
    {
      name: "durable Generation scope",
      select: (aggregate: DocumentStageRevisionAggregate) => {
        const [producer, publication] = validOperations(aggregate)
        return [
          {
            ...producer!,
            scope: {
              _tag: "GenerationScope",
              workflowId: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              unexpected: true,
            },
          },
          publication!,
        ] as const
      },
      operationId: (aggregate: DocumentStageRevisionAggregate) => aggregate.producerOperationId,
    },
  ])("rejects malformed aggregate operation authority: $name", async ({ select, operationId }) => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      expectAggregateCreateFailure(sql, store, aggregate, select(aggregate), {
        _tag: "QrspiStoreDataError",
        recordId: operationId(aggregate),
        reason: "malformed",
      }),
    )
  })

  test("rejects an oversized publication input before writing runtime rows", async () => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      Effect.gen(function* () {
        const [producer, publication] = validOperations(aggregate)
        const input = { ...publication!.input, uninterpreted: "x".repeat(33_000) }
        yield* expectAggregateCreateFailure(
          sql,
          store,
          aggregate,
          [producer!, { ...publication!, input, inputSha256: canonicalSha256(input) }],
          {
            _tag: "QrspiStoreDataError",
            recordId: aggregate.publicationOperationId,
            reason: "malformed",
          },
        )
      }),
    )
  })

  test("rejects the wrong aggregate operation kind", async () => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      Effect.gen(function* () {
        const [producer, publication] = validOperations(aggregate)
        yield* expectAggregateCreateFailure(
          sql,
          store,
          aggregate,
          [{ ...producer!, kind: "ArtifactPublish" }, publication!],
          {
            recordId: aggregate.producerOperationId,
            reason: "identity_mismatch",
          },
        )
      }),
    )
  })

  test("hash-binds the complete publication input", async () => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      Effect.gen(function* () {
        const [producer, publication] = validOperations(aggregate)
        const input = { ...publication!.input, requestedPath: "artifacts/changed-plan.md" }
        const actualSha256 = canonicalSha256(input)
        yield* expectAggregateCreateFailure(
          sql,
          store,
          aggregate,
          [producer!, { ...publication!, input }],
          {
            recordId: aggregate.publicationOperationId,
            reason: "hash_mismatch",
            expectedSha256: publication!.inputSha256,
            actualSha256,
          },
        )
      }),
    )
  })

  test("compares complete exact stage authority", async () => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      Effect.gen(function* () {
        const mismatchedSources = {
          ...aggregate.sources,
          stageDefinitionSha256: sha("9"),
        }
        const input = producerInput(aggregate, mismatchedSources)
        const [, publication] = validOperations(aggregate)
        yield* expectAggregateCreateFailure(
          sql,
          store,
          aggregate,
          [
            operation(
              aggregate.producerOperationId,
              "StageProduce",
              {
                _tag: "GenerationScope",
                workflowId: aggregate.sources.workflowId,
                generation: aggregate.sources.generation,
              },
              input,
            ),
            publication!,
          ],
          {
            recordId: aggregate.producerOperationId,
            reason: "identity_mismatch",
            expectedSha256: aggregate.sources.stageDefinitionSha256,
            actualSha256: mismatchedSources.stageDefinitionSha256,
          },
        )
      }),
    )
  })

  test("compares the durable Generation operation scope", async () => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      Effect.gen(function* () {
        const [producer, publication] = validOperations(aggregate)
        yield* expectAggregateCreateFailure(
          sql,
          store,
          aggregate,
          [
            producer!,
            {
              ...publication!,
              scope: {
                _tag: "GenerationScope",
                workflowId: aggregate.sources.workflowId,
                generation: aggregate.sources.generation + 1,
              },
            },
          ],
          {
            recordId: aggregate.publicationOperationId,
            reason: "identity_mismatch",
          },
        )
      }),
    )
  })
})

describe("document aggregate atomic persistence", () => {
  test("persists one exact document aggregate atomically", async () => {
    const aggregate = {
      ...documentAggregate(),
      publishedRevision: null,
    }
    await aggregateFixture(
      ({ sql, store, aggregate }) =>
        Effect.gen(function* () {
          yield* seedAggregatePrerequisites(sql, aggregate, validOperations(aggregate))
          const generationBefore = yield* sql<Record<string, unknown>>`
            SELECT generation_format, current_stage_key, current_stage_run_ordinal, state, is_current
            FROM qrspi_generations
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
          `
          const operationsBefore = yield* sql<Record<string, unknown>>`
            SELECT operation_id, state, is_current
            FROM workflow_operations
            WHERE operation_id IN (
              ${aggregate.producerOperationId}, ${aggregate.publicationOperationId}
            ) ORDER BY operation_id
          `

          const created = yield* store.createDocumentStageRuntimeAggregate(aggregate, now)
          expect(created).toEqual(aggregate)

          const run = yield* sql<Record<string, unknown>>`
            SELECT * FROM qrspi_stage_runs
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
              AND stage_key = ${aggregate.sources.stageKey}
              AND run_ordinal = ${aggregate.sources.runOrdinal}
          `
          expect(run).toEqual([
            {
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              run_ordinal: aggregate.sources.runOrdinal,
              workflow_definition_sha256: aggregate.sources.workflowDefinitionSha256,
              stage_definition_sha256: aggregate.sources.stageDefinitionSha256,
              state: aggregate.runState,
              is_current: 1,
              activation_policy_json:
                '{"mode":"conditional","policy":{"name":"qrspi.stage-activation","version":1},"decision":"enabled","reason":"The stage is selected for this generation"}',
              skip_reason: null,
              pending_revision: aggregate.sources.stageRevision,
              published_revision: null,
              accepted_revision: aggregate.sources.stageRevision,
              terminal_reason: null,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
          ])

          const revision = yield* sql<Record<string, unknown>>`
            SELECT * FROM qrspi_stage_revisions
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
              AND stage_key = ${aggregate.sources.stageKey}
          `
          expect(revision).toEqual([
            {
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              stage_revision: aggregate.sources.stageRevision,
              run_ordinal: aggregate.sources.runOrdinal,
              kind: "document",
              state: aggregate.revisionState,
              owner_crossing_key: aggregate.ownerCrossingKey,
              source_set_json: JSON.stringify([]),
              source_set_sha256: aggregate.sources.sourceSetSha256,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
          ])

          const document = yield* sql<Record<string, unknown>>`
            SELECT * FROM qrspi_document_stage_revisions
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
              AND stage_key = ${aggregate.sources.stageKey}
          `
          expect(document).toEqual([
            {
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              stage_revision: aggregate.sources.stageRevision,
              kind: "document",
              prepared_result_json: JSON.stringify(aggregate.preparedResult!.value),
              prepared_result_sha256: aggregate.preparedResult!.sha256,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
          ])

          const artifact = yield* sql<Record<string, unknown>>`
            SELECT * FROM qrspi_artifact_references
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
              AND stage_key = ${aggregate.sources.stageKey}
          `
          expect(artifact).toEqual([
            {
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              stage_revision: aggregate.sources.stageRevision,
              provider_instance_id: repository.providerInstanceId,
              repository_id: repository.repositoryId,
              repository_full_name: repository.repositoryFullName,
              commit_sha: aggregate.finalArtifact!.commitSha,
              path: aggregate.finalArtifact!.path,
              blob_sha: aggregate.finalArtifact!.blobSha,
              content_sha256: aggregate.finalArtifact!.contentSha256,
              media_type: aggregate.finalArtifact!.mediaType,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
          ])

          const commonOwners = yield* sql<Record<string, unknown>>`
            SELECT * FROM qrspi_stage_operation_owners
            WHERE operation_id IN (
              ${aggregate.producerOperationId}, ${aggregate.publicationOperationId}
            ) ORDER BY operation_role
          `
          expect(commonOwners).toEqual([
            {
              operation_id: aggregate.producerOperationId,
              operation_kind: "StageProduce",
              owner_kind: "document_revision",
              operation_role: "produce",
              created_at: now.toISOString(),
            },
            {
              operation_id: aggregate.publicationOperationId,
              operation_kind: "ArtifactPublish",
              owner_kind: "document_revision",
              operation_role: "publish",
              created_at: now.toISOString(),
            },
          ])
          const documentOwners = yield* sql<Record<string, unknown>>`
            SELECT * FROM qrspi_document_stage_revision_operations
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
              AND stage_key = ${aggregate.sources.stageKey}
            ORDER BY operation_role
          `
          expect(documentOwners).toEqual([
            {
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              stage_revision: aggregate.sources.stageRevision,
              owner_kind: "document_revision",
              operation_role: "produce",
              operation_id: aggregate.producerOperationId,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
            {
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              stage_revision: aggregate.sources.stageRevision,
              owner_kind: "document_revision",
              operation_role: "publish",
              operation_id: aggregate.publicationOperationId,
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
          ])

          const generationAfter = yield* sql<Record<string, unknown>>`
            SELECT generation_format, current_stage_key, current_stage_run_ordinal, state, is_current
            FROM qrspi_generations
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
          `
          const operationsAfter = yield* sql<Record<string, unknown>>`
            SELECT operation_id, state, is_current
            FROM workflow_operations
            WHERE operation_id IN (
              ${aggregate.producerOperationId}, ${aggregate.publicationOperationId}
            ) ORDER BY operation_id
          `
          expect(generationAfter).toEqual(generationBefore)
          expect(operationsAfter).toEqual(operationsBefore)
        }),
      aggregate,
    )
  })

  test("rolls back the complete document aggregate after a parent write", async () => {
    await aggregateFixture(({ sql, store, aggregate }) =>
      Effect.gen(function* () {
        yield* seedAggregatePrerequisites(sql, aggregate, validOperations(aggregate))
        yield* sql`
          CREATE TRIGGER crash_document_aggregate_ownership
          BEFORE INSERT ON qrspi_document_stage_revision_operations
          BEGIN
            SELECT RAISE(ABORT, 'simulated document aggregate crash');
          END
        `
        const exit = yield* store
          .createDocumentStageRuntimeAggregate(aggregate, now)
          .pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("SqlError")
        yield* expectNoDocumentAggregateRows(sql, aggregate)
      }),
    )
  })
})

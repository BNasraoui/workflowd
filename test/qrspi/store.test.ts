import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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

function technicalSource(
  role: "Structure" | "Design",
  stageKey: "structure" | "design",
  stageRevision: number,
  character: string,
) {
  const content = `# ${role}`
  const artifact = {
    repository,
    workflowId: "workflow-1",
    generation: 1,
    stageKey,
    stageRevision,
    commitSha: character.repeat(40),
    path: `artifacts/${stageKey}.md`,
    blobSha: character.repeat(40),
    contentSha256: createHash("sha256").update(content).digest("hex"),
    mediaType: "text/markdown",
  }
  const acceptedPointer = {
    role,
    snapshotSha256: sha(character),
    runOrdinal: 1,
    acceptedStageRevision: stageRevision,
    targetParentSha: character.repeat(40),
    contract: { name: `qrspi.${stageKey}`, contractVersion: 1 },
    contractRegistrationSha256: sha(character),
    artifact,
  }
  return {
    role,
    artifact,
    acceptedPointer: {
      ...acceptedPointer,
      pointerSha256: canonicalSha256(acceptedPointer),
    },
    content,
  }
}

function documentAggregate(): DocumentStageRevisionAggregate {
  const technicalSources = [
    technicalSource("Structure", "structure", 2, "6"),
    technicalSource("Design", "design", 1, "7"),
  ]
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
    sources: technicalSources,
    sourceSetSha256: canonicalSha256(
      technicalSources.map(({ role, artifact }) => ({ role, artifact })),
    ),
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

const generationScope = (aggregate: DocumentStageRevisionAggregate) => ({
  _tag: "GenerationScope" as const,
  workflowId: aggregate.sources.workflowId,
  generation: aggregate.sources.generation,
})

const revisionIdentity = (aggregate: DocumentStageRevisionAggregate) => ({
  workflowId: aggregate.sources.workflowId,
  generation: aggregate.sources.generation,
  stageKey: aggregate.sources.stageKey,
  runOrdinal: aggregate.sources.runOrdinal,
  stageRevision: aggregate.sources.stageRevision,
})

function historicalAggregate(
  aggregate: DocumentStageRevisionAggregate,
): DocumentStageRevisionAggregate {
  const sources = {
    ...aggregate.sources,
    runOrdinal: aggregate.sources.runOrdinal + 1,
    stageRevision: aggregate.sources.stageRevision + 1,
  }
  const revision = revisionIdentity({ ...aggregate, sources })
  return {
    ...aggregate,
    sources,
    isCurrent: false,
    ownerCrossingKey: `${aggregate.ownerCrossingKey}-historical`,
    pendingRevision: revision,
    publishedRevision: null,
    acceptedRevision: revision,
    finalArtifact: {
      ...aggregate.finalArtifact!,
      stageRevision: sources.stageRevision,
      commitSha: "a".repeat(40),
      blobSha: "b".repeat(40),
      contentSha256: sha("d"),
    },
    producerOperationId: `${aggregate.producerOperationId}-historical`,
    publicationOperationId: `${aggregate.publicationOperationId}-historical`,
  }
}

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
    generationScope(aggregate),
    producerInput(aggregate),
  ),
  operation(
    aggregate.publicationOperationId,
    "ArtifactPublish",
    generationScope(aggregate),
    publicationInput(aggregate),
  ),
]

const alterOperation = (
  aggregate: DocumentStageRevisionAggregate,
  index: 0 | 1,
  alter: (row: AggregateOperation) => AggregateOperation,
) => {
  const rows = validOperations(aggregate)
  rows[index] = alter(rows[index]!)
  return rows
}

const alterInput = (
  aggregate: DocumentStageRevisionAggregate,
  index: 0 | 1,
  input: Record<string, unknown>,
  rehash = true,
) =>
  alterOperation(aggregate, index, (row) => ({
    ...row,
    input,
    inputSha256: rehash ? canonicalSha256(input) : row.inputSha256,
  }))

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
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        (SELECT count(*) FROM qrspi_stage_runs WHERE ${identity}) AS runs,
        (SELECT count(*) FROM qrspi_stage_revisions WHERE ${identity}) AS revisions,
        (SELECT count(*) FROM qrspi_document_stage_revisions WHERE ${identity}) AS documents,
        (SELECT count(*) FROM qrspi_artifact_references WHERE ${identity}) AS artifacts,
        (SELECT count(*) FROM qrspi_stage_operation_owners WHERE operation_id IN (
          ${aggregate.producerOperationId}, ${aggregate.publicationOperationId}
        )) AS common_owners,
        (SELECT count(*) FROM qrspi_document_stage_revision_operations WHERE ${identity})
          AS document_owners
    `
    expect(rows).toEqual([
      { runs: 0, revisions: 0, documents: 0, artifacts: 0, common_owners: 0, document_owners: 0 },
    ])
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
      left: { _tag: "QrspiStoreDataError", record: "workflow_operation", ...expected },
    })
    yield* expectNoDocumentAggregateRows(sql, aggregate)
  })

const loadAggregateParents = (
  sql: SqlClient.SqlClient,
  aggregate: DocumentStageRevisionAggregate,
) => sql<Record<string, unknown>>`
  SELECT g.generation_format, g.current_stage_key, g.current_stage_run_ordinal,
    g.state AS generation_state, g.is_current AS generation_is_current, o.operation_id,
    o.state AS operation_state, o.is_current AS operation_is_current
  FROM qrspi_generations AS g
  JOIN workflow_operations AS o
    ON o.operation_id IN (${aggregate.producerOperationId}, ${aggregate.publicationOperationId})
  WHERE g.workflow_id = ${aggregate.sources.workflowId} AND g.generation = ${aggregate.sources.generation}
  ORDER BY o.operation_id
`

test("accepts one exact document aggregate", async () => {
  const aggregate = documentAggregate()

  await expect(
    Effect.runPromise(preflightDocumentStageRevisionAggregate(aggregate)),
  ).resolves.toEqual(aggregate)
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

test.each([
  { name: "run", field: "runOrdinal" as const },
  { name: "revision in the same run", field: "stageRevision" as const },
])("rejects a guarded pointer to another $name", async ({ field }) => {
  const aggregate = documentAggregate()
  const actualIdentity = {
    ...aggregate.pendingRevision!,
    [field]: aggregate.sources[field] + 1,
  }
  const result = await preflightFailure({
    ...aggregate,
    pendingRevision: actualIdentity,
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
        ...actualIdentity,
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

const authorityCase = (
  name: string,
  role: "producer" | "publication",
  reason: string,
  arrange: (aggregate: DocumentStageRevisionAggregate) => ReadonlyArray<AggregateOperation>,
  details?: (aggregate: DocumentStageRevisionAggregate) => Record<string, unknown>,
) => ({ name, role, reason, arrange, details })

describe("document aggregate operation authority", () => {
  test.each([
    authorityCase("missing aggregate operation", "publication", "missing", (aggregate) => [
      validOperations(aggregate)[0]!,
    ]),
    authorityCase("malformed producer input", "producer", "malformed", (aggregate) =>
      alterInput(aggregate, 0, { ...producerInput(aggregate), unexpected: true }),
    ),
    authorityCase(
      "malformed publication scope projection",
      "publication",
      "malformed",
      (aggregate) =>
        alterInput(aggregate, 1, {
          publicationReceipt: { requestId: "publish-request-1" },
        }),
    ),
    authorityCase("malformed scope_json", "producer", "malformed", (aggregate) =>
      alterOperation(aggregate, 0, (row) => ({
        ...row,
        scope: { ...generationScope(aggregate), unexpected: true },
      })),
    ),
    authorityCase("oversized publication input", "publication", "malformed", (aggregate) =>
      alterInput(aggregate, 1, {
        ...publicationInput(aggregate),
        uninterpreted: "x".repeat(33_000),
      }),
    ),
    authorityCase("wrong operation kind", "producer", "identity_mismatch", (aggregate) =>
      alterOperation(aggregate, 0, (row) => ({ ...row, kind: "ArtifactPublish" })),
    ),
    authorityCase(
      "complete publication input hash",
      "publication",
      "hash_mismatch",
      (aggregate) =>
        alterInput(
          aggregate,
          1,
          { ...publicationInput(aggregate), requestedPath: "artifacts/changed-plan.md" },
          false,
        ),
      (aggregate) => {
        const publication = validOperations(aggregate)[1]!
        return {
          expectedSha256: publication.inputSha256,
          actualSha256: canonicalSha256({
            ...publication.input,
            requestedPath: "artifacts/changed-plan.md",
          }),
        }
      },
    ),
    authorityCase(
      "exact stage definition hash",
      "producer",
      "identity_mismatch",
      (aggregate) => {
        const input = producerInput(aggregate, {
          ...aggregate.sources,
          stageDefinitionSha256: sha("9"),
        })
        return alterOperation(aggregate, 0, (row) => ({
          ...row,
          input,
          inputSha256: canonicalSha256(input),
        }))
      },
      (aggregate) => ({
        expectedSha256: aggregate.sources.stageDefinitionSha256,
        actualSha256: sha("9"),
      }),
    ),
    authorityCase("mismatched Generation scope", "publication", "identity_mismatch", (aggregate) =>
      alterOperation(aggregate, 1, (row) => ({
        ...row,
        scope: { ...generationScope(aggregate), generation: aggregate.sources.generation + 1 },
      })),
    ),
  ])("rejects aggregate operation authority: $name", async ({ arrange, details, reason, role }) => {
    await aggregateFixture(({ sql, store, aggregate }) => {
      const recordId =
        role === "producer" ? aggregate.producerOperationId : aggregate.publicationOperationId
      return expectAggregateCreateFailure(sql, store, aggregate, arrange(aggregate), {
        recordId,
        reason,
        ...details?.(aggregate),
      })
    })
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
          const parentsBefore = yield* loadAggregateParents(sql, aggregate)

          const created = yield* store.createDocumentStageRuntimeAggregate(aggregate, now)
          expect(created).toEqual(aggregate)

          const persisted = yield* sql<Record<string, unknown>>`
            SELECT run.workflow_id, run.generation, run.stage_key, run.run_ordinal,
              run.workflow_definition_sha256, run.stage_definition_sha256, run.state AS run_state,
              run.is_current, run.activation_policy_json, run.pending_revision,
              run.published_revision, run.accepted_revision,
              revision.stage_revision, revision.state AS revision_state, revision.owner_crossing_key,
              revision.source_set_json, revision.source_set_sha256, document.prepared_result_json,
              document.prepared_result_sha256,
              artifact.provider_instance_id, artifact.repository_id, artifact.repository_full_name,
              artifact.commit_sha, artifact.path, artifact.blob_sha, artifact.content_sha256,
              artifact.media_type, (
                run.created_at = ${now.toISOString()} AND run.updated_at = ${now.toISOString()}
                AND revision.created_at = ${now.toISOString()} AND revision.updated_at = ${now.toISOString()}
                AND document.created_at = ${now.toISOString()} AND document.updated_at = ${now.toISOString()}
                AND artifact.created_at = ${now.toISOString()} AND artifact.updated_at = ${now.toISOString()}) AS timestamps_match
            FROM qrspi_stage_runs AS run
            JOIN qrspi_stage_revisions AS revision
              USING (workflow_id, generation, stage_key, run_ordinal)
            JOIN qrspi_document_stage_revisions AS document
              USING (workflow_id, generation, stage_key, stage_revision)
            JOIN qrspi_artifact_references AS artifact
              USING (workflow_id, generation, stage_key, stage_revision)
            WHERE run.workflow_id = ${aggregate.sources.workflowId} AND run.generation = ${aggregate.sources.generation}
              AND run.stage_key = ${aggregate.sources.stageKey}
              AND run.run_ordinal = ${aggregate.sources.runOrdinal}
          `
          expect(persisted).toEqual([
            {
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              run_ordinal: aggregate.sources.runOrdinal,
              workflow_definition_sha256: aggregate.sources.workflowDefinitionSha256,
              stage_definition_sha256: aggregate.sources.stageDefinitionSha256,
              run_state: aggregate.runState,
              is_current: 1,
              activation_policy_json:
                '{"mode":"conditional","policy":{"name":"qrspi.stage-activation","version":1},"decision":"enabled","reason":"The stage is selected for this generation"}',
              pending_revision: aggregate.sources.stageRevision,
              published_revision: null,
              accepted_revision: aggregate.sources.stageRevision,
              stage_revision: aggregate.sources.stageRevision,
              revision_state: aggregate.revisionState,
              owner_crossing_key: aggregate.ownerCrossingKey,
              source_set_json: JSON.stringify(
                aggregate.sources.sources.map(({ role, artifact }) => ({ role, artifact })),
              ),
              source_set_sha256: aggregate.sources.sourceSetSha256,
              prepared_result_json: JSON.stringify(aggregate.preparedResult!.value),
              prepared_result_sha256: aggregate.preparedResult!.sha256,
              provider_instance_id: repository.providerInstanceId,
              repository_id: repository.repositoryId,
              repository_full_name: repository.repositoryFullName,
              commit_sha: aggregate.finalArtifact!.commitSha,
              path: aggregate.finalArtifact!.path,
              blob_sha: aggregate.finalArtifact!.blobSha,
              content_sha256: aggregate.finalArtifact!.contentSha256,
              media_type: aggregate.finalArtifact!.mediaType,
              timestamps_match: 1,
            },
          ])

          const owners = yield* sql<Record<string, unknown>>`
            SELECT common.operation_id, common.operation_role, document.workflow_id,
              document.generation, document.stage_key, document.stage_revision,
              (
                common.created_at = ${now.toISOString()} AND document.created_at = ${now.toISOString()}
                AND document.updated_at = ${now.toISOString()}
              ) AS timestamps_match
            FROM qrspi_stage_operation_owners AS common
            JOIN qrspi_document_stage_revision_operations AS document
              USING (operation_id, operation_role)
            WHERE common.operation_id IN (${aggregate.producerOperationId}, ${aggregate.publicationOperationId})
            ORDER BY common.operation_role
          `
          expect(owners).toEqual([
            {
              operation_id: aggregate.producerOperationId,
              operation_role: "produce",
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              stage_revision: aggregate.sources.stageRevision,
              timestamps_match: 1,
            },
            {
              operation_id: aggregate.publicationOperationId,
              operation_role: "publish",
              workflow_id: aggregate.sources.workflowId,
              generation: aggregate.sources.generation,
              stage_key: aggregate.sources.stageKey,
              stage_revision: aggregate.sources.stageRevision,
              timestamps_match: 1,
            },
          ])

          expect(yield* loadAggregateParents(sql, aggregate)).toEqual(parentsBefore)
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

describe("document aggregate reload", () => {
  test("reloads the exact requested aggregate deterministically beside newer history", async () => {
    const aggregate = { ...documentAggregate(), publishedRevision: null }
    await aggregateFixture(
      ({ sql, store, aggregate }) =>
        Effect.gen(function* () {
          yield* seedAggregatePrerequisites(sql, aggregate, validOperations(aggregate))
          yield* store.createDocumentStageRuntimeAggregate(aggregate, now)

          const historical = historicalAggregate(aggregate)
          yield* Effect.forEach(
            validOperations(historical),
            (row) => insertAggregateOperation(sql, row),
            { concurrency: 1 },
          )
          yield* store.createDocumentStageRuntimeAggregate(historical, now)

          const first = yield* store.readDocumentStageRuntimeAggregate(revisionIdentity(aggregate))
          const second = yield* store.readDocumentStageRuntimeAggregate(revisionIdentity(aggregate))
          expect(first).toEqual(aggregate)
          expect(second).toEqual(first)
          expect(first.sources.sources.map(({ role }) => role)).toEqual(["Structure", "Design"])
        }),
      aggregate,
    )
  })

  test("returns typed missing instead of a partial aggregate", async () => {
    const aggregate = { ...documentAggregate(), publishedRevision: null }
    await aggregateFixture(
      ({ sql, store, aggregate }) =>
        Effect.gen(function* () {
          yield* seedAggregatePrerequisites(sql, aggregate, validOperations(aggregate))
          yield* store.createDocumentStageRuntimeAggregate(aggregate, now)
          yield* sql`
            DELETE FROM qrspi_document_stage_revision_operations
            WHERE workflow_id = ${aggregate.sources.workflowId}
              AND generation = ${aggregate.sources.generation}
              AND stage_key = ${aggregate.sources.stageKey}
              AND stage_revision = ${aggregate.sources.stageRevision}
              AND operation_role = 'publish'
          `

          const result = yield* store
            .readDocumentStageRuntimeAggregate(revisionIdentity(aggregate))
            .pipe(Effect.either)
          expect(result).toMatchObject({
            _tag: "Left",
            left: {
              _tag: "QrspiStoreDataError",
              record: "document_stage_revision_aggregate",
              reason: "missing",
            },
          })
        }),
      aggregate,
    )
  })
})

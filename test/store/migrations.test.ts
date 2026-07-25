import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Either, Layer } from "effect"
import { makeCurrentnessPolicy } from "../../src/store/currentness"
import {
  commandClaimCandidate,
  reconciliationClaimCandidate,
} from "../../src/store/internal-claim-queries"
import {
  reconciliationObservationSequence,
  runStoreMigrations,
  runStoreMigrationsThrough0010,
} from "../../src/store/migrations"
import { makeStoreLayer } from "./harness"

const timestamp = "2026-07-19T12:00:00.000Z"
const reviewJson = JSON.stringify({
  verdict: "changes_requested",
  summary: "One issue.",
  findings: [{ severity: "high", title: "Unsafe retry", body: "Not idempotent." }],
})
const fixResultJson = JSON.stringify({
  _tag: "NoChanges",
  summary: "No changes were needed.",
})

type StoreServices = Layer.Layer.Success<ReturnType<typeof makeStoreLayer>>

const runWithDatabase = <A, E>(effect: Effect.Effect<A, E, StoreServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeStoreLayer())))

const rejected = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.either, Effect.map(Either.isLeft))

type ColumnMetadata = {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: string | null
  readonly pk: number
}

type ForeignKeyMetadata = {
  readonly id: number
  readonly seq: number
  readonly table: string
  readonly from: string
  readonly to: string
  readonly on_update: string
  readonly on_delete: string
}

type IndexMetadata = {
  readonly name: string
  readonly unique: number
  readonly partial: number
  readonly origin: string
}

const readTableMetadata = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql.unsafe<ColumnMetadata>(
      `SELECT name, type, "notnull", dflt_value, pk
       FROM pragma_table_info(?) ORDER BY cid`,
      [table],
    )
    const foreignKeys = yield* sql.unsafe<ForeignKeyMetadata>(
      `SELECT id, seq, "table", "from", "to", on_update, on_delete
       FROM pragma_foreign_key_list(?) ORDER BY id, seq`,
      [table],
    )
    const indexes = yield* sql.unsafe<IndexMetadata>(
      `SELECT name, "unique", partial, origin
       FROM pragma_index_list(?) ORDER BY name`,
      [table],
    )
    const ddl = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
    `
    return { columns, ddl: ddl[0]?.sql, foreignKeys, indexes }
  })

const readIndexColumns = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe<{ readonly name: string; readonly seqno: number }>(
      `SELECT name, seqno FROM pragma_index_info(?) ORDER BY seqno`,
      [name],
    )
  })

const readIndexDdl = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}
    `
    return rows[0]?.sql
  })

const readIndexInventory = (indexes: ReadonlyArray<IndexMetadata>) =>
  Effect.all(
    indexes.map((index) =>
      readIndexColumns(index.name).pipe(Effect.map((columns) => ({ ...index, columns }))),
    ),
  )

const groupForeignKeys = (foreignKeys: ReadonlyArray<ForeignKeyMetadata>) =>
  Object.values(Object.groupBy(foreignKeys, ({ id }) => id)).map((rows) => ({
    id: rows![0]!.id,
    seq: rows!.map((row) => row.seq),
    table: rows![0]!.table,
    from: rows!.map((row) => row.from),
    to: rows!.map((row) => row.to),
    onUpdate: rows![0]!.on_update,
    onDelete: rows![0]!.on_delete,
  }))

const noActionForeignKey = (id: number, table: string, from: Array<string>, to: Array<string>) => ({
  id,
  seq: from.map((_, seq) => seq),
  table,
  from,
  to,
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
})

const compactDdl = (ddl: string | undefined) => ddl?.replaceAll(/\s+/g, " ").trim()

const seedSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO webhook_deliveries (delivery_id, event, action, payload, received_at)
    VALUES ('delivery-1', 'pull_request', 'opened', '{}', ${timestamp})
  `
  yield* sql`
    INSERT INTO pull_requests (
      repository_id, pull_request_number, installation_id, repository_full_name,
      repository_owner, repository_name, author, base_ref, base_sha, draft,
      head_ref, head_repository_full_name, head_sha, github_updated_at, state,
      generation, updated_at
    ) VALUES (
      42, 7, 91, 'example-owner/example', 'example-owner', 'example', 'opencode-agent',
      'main', ${"d".repeat(40)}, FALSE, 'opencode/example-job',
      'example-owner/example', ${"a".repeat(40)}, NULL, 'open', 1, ${timestamp}
    )
  `
  yield* sql`
    INSERT INTO publications (
      id, operation_key, installation_id, repository_id, repository_full_name,
      pull_request_number, base_ref, base_sha, expected_head_sha, head_ref,
      head_repository_full_name, generation, review_request_number,
      review_json, state, attempts, max_attempts, run_at, lease_owner,
      lease_until, last_error, created_at, updated_at
    ) VALUES (
      1, 'review:42:7:1', 91, 42, 'example-owner/example', 7, 'main',
      ${"d".repeat(40)}, ${"a".repeat(40)}, 'opencode/example-job',
      'example-owner/example', 1, 1, ${reviewJson}, 'ready', 0, 5, ${timestamp}, NULL, NULL, NULL,
      ${timestamp}, ${timestamp}
    )
  `
  yield* sql`
    INSERT INTO jobs (
      id, kind, installation_id, repository_id, repository_full_name,
      pull_request_number, author, base_ref, base_sha, expected_head_sha,
      head_ref, head_repository_full_name, generation, review_request_number,
      publication_id, review_json, fix_result_json, state, attempts,
      max_attempts, run_at, lease_owner, lease_until, cancel_requested,
      last_error, created_at, updated_at
    ) VALUES
      (
        1, 'review', 91, 42, 'example-owner/example', 7, 'opencode-agent', 'main',
        ${"d".repeat(40)}, ${"a".repeat(40)}, 'opencode/example-job',
        'example-owner/example', 1, 1, NULL, NULL, NULL, 'ready', 0, 3,
        ${timestamp}, NULL, NULL, FALSE, NULL, ${timestamp}, ${timestamp}
      ),
      (
        2, 'fix', 91, 42, 'example-owner/example', 7, 'opencode-agent', 'main',
        ${"d".repeat(40)}, ${"a".repeat(40)}, 'opencode/example-job',
        'example-owner/example', 1, 1, 1, ${reviewJson}, NULL, 'ready', 0, 3,
        ${timestamp}, NULL, NULL, FALSE, NULL, ${timestamp}, ${timestamp}
      )
  `
  yield* sql`
    INSERT INTO commands (
      id, delivery_id, command, comment_id, commenter, installation_id,
      repository_id, repository_full_name, pull_request_number, state,
      attempts, max_attempts, run_at, lease_owner, lease_until, last_error,
      created_at, updated_at
    ) VALUES (
      1, 'delivery-1', 'status', 100, 'example-owner', 91, 42,
      'example-owner/example', 7, 'ready', 0, 3, ${timestamp}, NULL, NULL, NULL,
      ${timestamp}, ${timestamp}
    )
  `
  yield* sql`
    INSERT INTO reconciliations (
      id, installation_id, repository_id, repository_full_name,
      pull_request_number, state, attempts, max_attempts, run_at, lease_owner,
      lease_until, last_error, created_at, updated_at
    ) VALUES (
      1, 91, 42, 'example-owner/example', 7, 'ready', 0, 5, ${timestamp},
      NULL, NULL, NULL, ${timestamp}, ${timestamp}
    )
  `
})

describe("strict initial store schema", () => {
  test("applies the strict store migrations while initializing the store", async () => {
    const result = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* sql`PRAGMA busy_timeout = 5000`
        const migrations = yield* sql`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
        `
        const tables = yield* sql`
          SELECT name, strict
          FROM pragma_table_list
          WHERE name IN (
            'webhook_deliveries', 'pull_requests', 'jobs', 'publications',
            'commands', 'reconciliations', 'agent_executions', 'qrspi_workflows',
            'qrspi_ticket_revisions', 'qrspi_workflow_definitions',
            'workflow_operations', 'workflow_operation_gates', 'qrspi_generations',
            'qrspi_stage_definitions', 'qrspi_stage_runs', 'qrspi_stage_revisions',
            'qrspi_document_stage_revisions', 'qrspi_implementation_stage_revisions',
            'qrspi_implementation_steps', 'qrspi_artifact_references',
            'qrspi_implementation_commit_references', 'qrspi_implementation_checkpoints',
            'qrspi_stage_revision_diagnostics', 'qrspi_stage_operation_owners',
            'qrspi_document_stage_revision_operations',
            'qrspi_implementation_step_operations'
          )
          ORDER BY name
        `
        const foreignKeys = yield* sql`PRAGMA foreign_keys`
        const busyTimeout = yield* sql`PRAGMA busy_timeout`
        return { busyTimeout, foreignKeys, migrations, tables }
      }),
    )

    expect(result.migrations).toEqual([
      { migration_id: 1, name: "initial_schema" },
      { migration_id: 2, name: "agent_harness" },
      { migration_id: 3, name: "agent_session_cleanup_leases" },
      { migration_id: 4, name: "agent_session_recovery_and_payload_envelopes" },
      { migration_id: 5, name: "qrspi_workflow_start" },
      { migration_id: 6, name: "fix_publication_signing_evidence" },
      { migration_id: 7, name: "reconciliation_observation_watermark" },
      { migration_id: 8, name: "reconciliation_observation_sequence" },
      { migration_id: 9, name: "qrspi_stage_definitions" },
      { migration_id: 10, name: "qrspi_generation_format" },
      { migration_id: 11, name: "qrspi_stage_runtime_layout" },
    ])
    expect(result.tables).toHaveLength(26)
    expect(result.tables.every((table) => table.strict === 1)).toBe(true)
    expect(result.foreignKeys).toEqual([{ foreign_keys: 1 }])
    expect(result.busyTimeout).toEqual([{ timeout: 5000 }])
  })

  test("backfills reused reconciliation authority from its latest update", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          CREATE TABLE webhook_deliveries (
            delivery_id TEXT PRIMARY KEY,
            received_at TEXT NOT NULL
          ) STRICT
        `
        yield* sql`
          CREATE TABLE reconciliations (
            id INTEGER PRIMARY KEY,
            observation_received_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT
        `
        yield* sql`
          INSERT INTO webhook_deliveries (delivery_id, received_at)
          VALUES
            ('first', '2026-07-19T12:00:00.000Z'),
            ('latest', '2026-07-19T12:05:00.000Z')
        `
        yield* sql`
          INSERT INTO reconciliations (id, observation_received_at, created_at, updated_at)
          VALUES (
            1,
            '2026-07-19T12:00:00.000Z',
            '2026-07-19T12:00:00.000Z',
            '2026-07-19T12:05:00.000Z'
          )
        `

        yield* reconciliationObservationSequence

        return yield* sql<{
          readonly observation_received_at: string
          readonly observation_sequence: number
        }>`
          SELECT observation_received_at, observation_sequence
          FROM reconciliations
          WHERE id = 1
        `
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )

    expect(result).toEqual([
      {
        observation_received_at: "2026-07-19T12:05:00.000Z",
        observation_sequence: 2,
      },
    ])
  })

  test("scopes identical ticket revision hashes to their owning workflow", async () => {
    const primaryKey = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly name: string; readonly pk: number }>`
          SELECT name, pk FROM pragma_table_info('qrspi_ticket_revisions')
          WHERE pk > 0 ORDER BY pk
        `
      }),
    )

    expect(primaryKey).toEqual([
      { name: "workflow_id", pk: 1 },
      { name: "ticket_revision_sha256", pk: 2 },
    ])
  })

  test("rejects invalid leased and non-leased Work State rows", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* seedSchema
        return yield* Effect.all(
          ["jobs", "publications", "commands", "reconciliations"].flatMap((table) => [
            rejected(sql.unsafe(`UPDATE ${table} SET state = 'leased' WHERE id = 1`)),
            rejected(
              sql.unsafe(
                `UPDATE ${table} SET lease_owner = 'worker', lease_until = ? WHERE id = 1`,
                [timestamp],
              ),
            ),
          ]),
        )
      }),
    )

    expect(results).toEqual(Array.from({ length: 8 }, () => true))
  })

  test("rejects invalid attempt, retry, failure, and stale-error states", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* seedSchema
        return yield* Effect.all(
          ["jobs", "publications", "commands", "reconciliations"].flatMap((table) => [
            rejected(sql.unsafe(`UPDATE ${table} SET attempts = -1 WHERE id = 1`)),
            rejected(sql.unsafe(`UPDATE ${table} SET max_attempts = 0 WHERE id = 1`)),
            rejected(sql.unsafe(`UPDATE ${table} SET attempts = max_attempts + 1 WHERE id = 1`)),
            rejected(sql.unsafe(`UPDATE ${table} SET state = 'retry_scheduled' WHERE id = 1`)),
            rejected(sql.unsafe(`UPDATE ${table} SET state = 'failed' WHERE id = 1`)),
            rejected(sql.unsafe(`UPDATE ${table} SET state = 'data_error' WHERE id = 1`)),
            rejected(sql.unsafe(`UPDATE ${table} SET last_error = 'stale' WHERE id = 1`)),
            rejected(sql.unsafe(`UPDATE ${table} SET run_at = NULL WHERE id = 1`)),
          ]),
        )
      }),
    )

    expect(results).toEqual(Array.from({ length: 32 }, () => true))
  })

  test("rejects invalid durable Command identifiers and text", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* seedSchema
        return yield* Effect.all([
          rejected(sql`UPDATE commands SET id = 0 WHERE id = 1`),
          rejected(sql`UPDATE commands SET comment_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE commands SET commenter = '' WHERE id = 1`),
          rejected(sql`UPDATE commands SET installation_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE commands SET repository_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE commands SET repository_full_name = '' WHERE id = 1`),
          rejected(sql`UPDATE commands SET pull_request_number = 0 WHERE id = 1`),
        ])
      }),
    )

    expect(results.every(Boolean)).toBe(true)
  })

  test("rejects malformed Publication identity and Review Target values", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedSchema
        yield* sql`PRAGMA foreign_keys = OFF`
        return yield* Effect.all([
          rejected(sql`UPDATE publications SET id = 0 WHERE id = 1`),
          rejected(sql`UPDATE publications SET operation_key = '' WHERE id = 1`),
          rejected(sql`UPDATE publications SET installation_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE publications SET repository_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE publications SET repository_full_name = '' WHERE id = 1`),
          rejected(sql`UPDATE publications SET pull_request_number = 0 WHERE id = 1`),
          rejected(sql`UPDATE publications SET base_ref = '' WHERE id = 1`),
          rejected(sql`UPDATE publications SET base_sha = ${"d".repeat(39)} WHERE id = 1`),
          rejected(sql`UPDATE publications SET expected_head_sha = ${"g".repeat(40)} WHERE id = 1`),
          rejected(sql`UPDATE publications SET head_ref = '' WHERE id = 1`),
          rejected(sql`UPDATE publications SET head_repository_full_name = '' WHERE id = 1`),
        ])
      }),
    )

    expect(results).toHaveLength(11)
    expect(results.every(Boolean)).toBe(true)
  })

  test("rejects malformed Job identity and Review Target values", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedSchema
        yield* sql`PRAGMA foreign_keys = OFF`
        return yield* Effect.all([
          rejected(sql`UPDATE jobs SET id = 0 WHERE id = 1`),
          rejected(sql`UPDATE jobs SET installation_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE jobs SET repository_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE jobs SET repository_full_name = '' WHERE id = 1`),
          rejected(sql`UPDATE jobs SET pull_request_number = 0 WHERE id = 1`),
          rejected(sql`UPDATE jobs SET author = '' WHERE id = 1`),
          rejected(sql`UPDATE jobs SET base_ref = '' WHERE id = 1`),
          rejected(sql`UPDATE jobs SET base_sha = ${"d".repeat(39)} WHERE id = 1`),
          rejected(sql`UPDATE jobs SET expected_head_sha = ${"g".repeat(40)} WHERE id = 1`),
          rejected(sql`UPDATE jobs SET head_ref = '' WHERE id = 1`),
          rejected(sql`UPDATE jobs SET head_repository_full_name = '' WHERE id = 1`),
          rejected(sql`UPDATE jobs SET publication_id = 0 WHERE id = 2`),
        ])
      }),
    )

    expect(results).toHaveLength(12)
    expect(results.every(Boolean)).toBe(true)
  })

  test("rejects malformed Reconciliation identity values", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedSchema
        yield* sql`PRAGMA foreign_keys = OFF`
        return yield* Effect.all([
          rejected(sql`UPDATE reconciliations SET id = 0 WHERE id = 1`),
          rejected(sql`UPDATE reconciliations SET installation_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE reconciliations SET repository_id = 0 WHERE id = 1`),
          rejected(sql`UPDATE reconciliations SET repository_full_name = '' WHERE id = 1`),
          rejected(sql`UPDATE reconciliations SET pull_request_number = 0 WHERE id = 1`),
        ])
      }),
    )

    expect(results).toHaveLength(5)
    expect(results.every(Boolean)).toBe(true)
  })

  test("rejects invalid review and fix job combinations", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* seedSchema
        return yield* Effect.all([
          rejected(sql`UPDATE jobs SET publication_id = 1 WHERE id = 1`),
          rejected(sql`UPDATE jobs SET review_json = ${reviewJson} WHERE id = 1`),
          rejected(sql`UPDATE jobs SET fix_result_json = ${fixResultJson} WHERE id = 1`),
          rejected(sql`UPDATE jobs SET publication_id = NULL WHERE id = 2`),
          rejected(sql`UPDATE jobs SET review_json = NULL WHERE id = 2`),
          rejected(
            sql`UPDATE jobs SET review_json = ${JSON.stringify({
              verdict: "pass",
              summary: "Pass.",
              findings: [],
            })} WHERE id = 2`,
          ),
        ])
      }),
    )

    expect(results).toHaveLength(6)
    expect(results.every(Boolean)).toBe(true)
  })

  test("rejects invalid persisted review and fix JSON", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* seedSchema
        return yield* Effect.all([
          rejected(sql`UPDATE publications SET review_json = '{not-json' WHERE id = 1`),
          rejected(
            sql`UPDATE publications SET review_json = ${JSON.stringify({
              verdict: "pass",
              summary: "Contradictory.",
              findings: [{}],
            })} WHERE id = 1`,
          ),
          rejected(sql`UPDATE jobs SET review_json = '[]' WHERE id = 2`),
          rejected(sql`UPDATE jobs SET fix_result_json = '{not-json' WHERE id = 2`),
          rejected(sql`UPDATE jobs SET fix_result_json = '[]' WHERE id = 2`),
        ])
      }),
    )

    expect(results).toHaveLength(5)
    expect(results.every(Boolean)).toBe(true)
  })

  test("rejects non-positive Generation and Review Request numbers", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* seedSchema
        return yield* Effect.all([
          rejected(sql`UPDATE pull_requests SET generation = 0`),
          rejected(sql`UPDATE jobs SET generation = 0 WHERE id = 1`),
          rejected(sql`UPDATE jobs SET review_request_number = 0 WHERE id = 1`),
          rejected(sql`UPDATE publications SET generation = 0 WHERE id = 1`),
          rejected(sql`UPDATE publications SET review_request_number = 0 WHERE id = 1`),
        ])
      }),
    )

    expect(results).toHaveLength(5)
    expect(results.every(Boolean)).toBe(true)
  })

  test("rejects malformed core pull request identity and Review Target values", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const valid = {
          repositoryId: 142,
          pullRequestNumber: 17,
          installationId: 191,
          repositoryFullName: "example-owner/example",
          repositoryOwner: "example-owner",
          repositoryName: "example",
          author: "opencode-agent",
          baseRef: "main",
          baseSha: "d".repeat(40),
          headRef: "opencode/example-job",
          headRepositoryFullName: "example-owner/example",
          headSha: "a".repeat(40),
          generation: 1,
        }
        const malformed = [
          { ...valid, repositoryId: 0 },
          { ...valid, pullRequestNumber: 0 },
          { ...valid, installationId: 0 },
          { ...valid, generation: 0 },
          { ...valid, repositoryFullName: "" },
          { ...valid, repositoryOwner: "" },
          { ...valid, repositoryName: "" },
          { ...valid, author: "" },
          { ...valid, baseRef: "" },
          { ...valid, headRef: "" },
          { ...valid, headRepositoryFullName: "" },
          { ...valid, baseSha: "d".repeat(39) },
          { ...valid, headSha: "g".repeat(40) },
        ]

        return yield* Effect.all(
          malformed.map((row) =>
            rejected(sql`
              INSERT INTO pull_requests (
                repository_id, pull_request_number, installation_id,
                repository_full_name, repository_owner, repository_name,
                author, base_ref, base_sha, draft, head_ref,
                head_repository_full_name, head_sha, github_updated_at, state,
                generation, updated_at
              ) VALUES (
                ${row.repositoryId}, ${row.pullRequestNumber},
                ${row.installationId}, ${row.repositoryFullName},
                ${row.repositoryOwner}, ${row.repositoryName}, ${row.author},
                ${row.baseRef}, ${row.baseSha}, FALSE, ${row.headRef},
                ${row.headRepositoryFullName}, ${row.headSha}, NULL, 'open',
                ${row.generation}, ${timestamp}
              )
            `),
          ),
        )
      }),
    )

    expect(results).toEqual(Array.from({ length: 13 }, () => true))
  })

  test("rejects a fix job with a missing source Publication", async () => {
    const wasRejected = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* seedSchema
        return yield* rejected(sql`UPDATE jobs SET publication_id = 999 WHERE id = 2`)
      }),
    )

    expect(wasRejected).toBe(true)
  })

  test("uses preserved indexes for production claim and identity queries", async () => {
    const plans = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const currentness = makeCurrentnessPolicy(sql)
        const explainQueryPlan = sql.literal("EXPLAIN QUERY PLAN")
        const simpleClaims = yield* Effect.all([
          sql`${explainQueryPlan} ${commandClaimCandidate(sql, timestamp)}`,
          sql`${explainQueryPlan} ${reconciliationClaimCandidate(sql, timestamp)}`,
        ])
        const jobClaim = yield* sql`
          ${explainQueryPlan} ${currentness.jobClaimCandidate(timestamp)}
        `
        const publicationClaim = yield* sql`
          ${explainQueryPlan} ${currentness.publicationClaimCandidate(timestamp)}
        `
        const publicationIdentity = yield* sql`
          EXPLAIN QUERY PLAN
          SELECT id FROM publications
          WHERE repository_id = 42 AND pull_request_number = 7
          AND generation = 1 AND review_request_number < 3
        `
        return [jobClaim, publicationClaim, ...simpleClaims, publicationIdentity].map((plan) =>
          plan.flatMap(Object.values).map(String).join("\n"),
        )
      }),
    )

    expect(plans[0]).toContain("jobs_claimable")
    expect(plans[0]).toContain("jobs_identity")
    expect(plans[1]).toContain("publications_claimable")
    expect(plans[1]).toContain("jobs_identity")
    expect(plans[2]).toContain("commands_claimable")
    expect(plans[3]).toContain("reconciliations_claimable")
    expect(plans[4]).toContain("publications_identity")
  })
})

describe("migration 11: QRSPI stage runtime identity spine", () => {
  const runtimeTables = [
    "qrspi_stage_runs",
    "qrspi_stage_revisions",
    "qrspi_document_stage_revisions",
    "qrspi_implementation_stage_revisions",
    "qrspi_implementation_steps",
    "qrspi_artifact_references",
    "qrspi_implementation_commit_references",
    "qrspi_implementation_checkpoints",
    "qrspi_stage_revision_diagnostics",
    "qrspi_stage_operation_owners",
    "qrspi_document_stage_revision_operations",
    "qrspi_implementation_step_operations",
  ] as const

  const originalGenerationColumns: ReadonlyArray<ColumnMetadata> = [
    { name: "workflow_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "generation", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
    { name: "repository_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "base_ref", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "base_sha", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "head_ref", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "root_sha", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "current_head_sha", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    {
      name: "ticket_revision_sha256",
      type: "TEXT",
      notnull: 1,
      dflt_value: null,
      pk: 0,
    },
    {
      name: "workflow_definition_sha256",
      type: "TEXT",
      notnull: 1,
      dflt_value: null,
      pk: 0,
    },
    { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "is_current", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    {
      name: "generation_format",
      type: "TEXT",
      notnull: 1,
      dflt_value: "'legacy'",
      pk: 0,
    },
  ]

  const stageRunColumns: ReadonlyArray<ColumnMetadata> = [
    { name: "workflow_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "generation", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
    { name: "stage_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 3 },
    { name: "run_ordinal", type: "INTEGER", notnull: 1, dflt_value: null, pk: 4 },
    {
      name: "workflow_definition_sha256",
      type: "TEXT",
      notnull: 1,
      dflt_value: null,
      pk: 0,
    },
    {
      name: "stage_definition_sha256",
      type: "TEXT",
      notnull: 1,
      dflt_value: null,
      pk: 0,
    },
    { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "is_current", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    {
      name: "activation_policy_json",
      type: "TEXT",
      notnull: 1,
      dflt_value: null,
      pk: 0,
    },
    { name: "skip_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "pending_revision", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "published_revision", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "accepted_revision", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "terminal_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ]

  const stageRevisionColumns: ReadonlyArray<ColumnMetadata> = [
    { name: "workflow_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "generation", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 },
    { name: "stage_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 3 },
    { name: "stage_revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 4 },
    { name: "run_ordinal", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "owner_crossing_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "source_set_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "source_set_sha256", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ]

  test("retains the through-0010 migration frontier", async () => {
    const migrations = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runStoreMigrationsThrough0010
        return yield* sql`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
        `
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )

    expect(migrations.at(-1)).toEqual({ migration_id: 10, name: "qrspi_generation_format" })
    expect(migrations).toHaveLength(10)
  })

  test("preserves the Generation schema and adds only a guarded runtime cursor", async () => {
    const result = await runWithDatabase(
      Effect.gen(function* () {
        const generation = yield* readTableMetadata("qrspi_generations")
        const currentDdl = yield* readIndexDdl("qrspi_generations_current")
        const indexes = yield* readIndexInventory(generation.indexes)
        return { generation, currentDdl, indexes }
      }),
    )

    expect(result.generation.columns).toEqual([
      ...originalGenerationColumns,
      { name: "current_stage_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "current_stage_run_ordinal",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
    ])
    expect(groupForeignKeys(result.generation.foreignKeys)).toEqual([
      {
        id: 0,
        seq: [0, 1, 2, 3],
        table: "qrspi_stage_runs",
        from: ["workflow_id", "generation", "current_stage_key", "current_stage_run_ordinal"],
        to: ["workflow_id", "generation", "stage_key", "run_ordinal"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
      },
      {
        id: 1,
        seq: [0, 1],
        table: "qrspi_ticket_revisions",
        from: ["workflow_id", "ticket_revision_sha256"],
        to: ["workflow_id", "ticket_revision_sha256"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
      },
      {
        id: 2,
        seq: [0],
        table: "qrspi_workflow_definitions",
        from: ["workflow_definition_sha256"],
        to: ["definition_sha256"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
      },
      {
        id: 3,
        seq: [0],
        table: "qrspi_workflows",
        from: ["workflow_id"],
        to: ["workflow_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
      },
    ])
    expect(result.indexes).toEqual([
      {
        name: "qrspi_generations_current",
        unique: 1,
        partial: 1,
        origin: "c",
        columns: [{ name: "workflow_id", seqno: 0 }],
      },
      {
        name: "qrspi_generations_definition",
        unique: 1,
        partial: 0,
        origin: "c",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
          { name: "workflow_definition_sha256", seqno: 2 },
        ],
      },
      {
        name: "sqlite_autoindex_qrspi_generations_1",
        unique: 1,
        partial: 0,
        origin: "pk",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
        ],
      },
    ])
    expect(compactDdl(result.currentDdl)).toBe(
      "CREATE UNIQUE INDEX qrspi_generations_current ON qrspi_generations (workflow_id) WHERE is_current = 1",
    )
    expect(result.generation.ddl).toContain(
      "generation_format IN ('legacy', 'stage_snapshots_v1', 'stage_runtime_v1')",
    )
    expect(result.generation.ddl).toContain(
      "(current_stage_key IS NULL) = (current_stage_run_ordinal IS NULL)",
    )
    expect(result.generation.ddl).toContain("current_stage_run_ordinal BETWEEN 1 AND 1000000")
    expect(result.generation.ddl).toContain(
      "current_stage_key IS NULL OR length(current_stage_key) BETWEEN 1 AND 64",
    )
    expect(result.generation.ddl).not.toContain("current_stage_key TEXT DEFAULT")
    expect(result.generation.ddl).not.toContain("current_stage_run_ordinal INTEGER DEFAULT")
  })

  test("preserves through-0010 Generation values without inferring runtime facts", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const workflowDefinitionSha256 = "b".repeat(64)
        const ticketRevisionSha256 = "a".repeat(64)
        const baseSha = "c".repeat(40)
        yield* sql`PRAGMA foreign_keys = ON`
        yield* runStoreMigrationsThrough0010
        yield* sql`
          INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
          VALUES ('workflow-1', 'workflow-branch', ${timestamp}, ${timestamp})
        `
        yield* sql`
          INSERT INTO qrspi_ticket_revisions (
            workflow_id, ticket_revision_sha256, revision_json, checked_at
          ) VALUES ('workflow-1', ${ticketRevisionSha256}, '{"ticket":1}', ${timestamp})
        `
        yield* sql`
          INSERT INTO qrspi_workflow_definitions (definition_sha256, definition_json, created_at)
          VALUES (${workflowDefinitionSha256}, '{"workflow":1}', ${timestamp})
        `
        yield* sql`
          INSERT INTO qrspi_generations (
            workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
            root_sha, current_head_sha, ticket_revision_sha256,
            workflow_definition_sha256, state, is_current, created_at, updated_at,
            generation_format
          ) VALUES (
            'workflow-1', 3, '{"repository":1}', 'main', ${baseSha}, 'workflow-branch',
            ${baseSha}, ${baseSha}, ${ticketRevisionSha256}, ${workflowDefinitionSha256},
            'waiting_human', 1, ${timestamp}, ${timestamp}, 'stage_snapshots_v1'
          )
        `
        const before = yield* sql`SELECT * FROM qrspi_generations`
        yield* runStoreMigrations
        const after = yield* sql`SELECT * FROM qrspi_generations`
        const runCount = yield* sql`SELECT count(*) AS count FROM qrspi_stage_runs`
        const revisionCount = yield* sql`SELECT count(*) AS count FROM qrspi_stage_revisions`
        const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`
        return { after, before, foreignKeyViolations, revisionCount, runCount }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )

    expect(result.after).toEqual([
      { ...result.before[0], current_stage_key: null, current_stage_run_ordinal: null },
    ])
    expect(result.runCount).toEqual([{ count: 0 }])
    expect(result.revisionCount).toEqual([{ count: 0 }])
    expect(result.foreignKeyViolations).toEqual([])
  })

  test("creates the exact strict StageRun and common StageRevision identities", async () => {
    const result = await runWithDatabase(
      Effect.gen(function* () {
        const stageRun = yield* readTableMetadata("qrspi_stage_runs")
        const stageRevision = yield* readTableMetadata("qrspi_stage_revisions")
        const stageDefinition = yield* readTableMetadata("qrspi_stage_definitions")
        const strictTables = yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) => sql`
            SELECT name, strict FROM pragma_table_list
            WHERE name IN ('qrspi_stage_runs', 'qrspi_stage_revisions') ORDER BY name
          `,
          ),
        )
        const currentDdl = yield* readIndexDdl("qrspi_stage_runs_current")
        const runIndexes = yield* readIndexInventory(stageRun.indexes)
        const revisionIndexes = yield* readIndexInventory(stageRevision.indexes)
        const stageDefinitionIndexes = yield* readIndexInventory(stageDefinition.indexes)
        return {
          currentDdl,
          revisionIndexes,
          runIndexes,
          stageDefinitionIndexes,
          stageRevision,
          stageRun,
          strictTables,
        }
      }),
    )

    expect(result.stageRun.columns).toEqual(stageRunColumns)
    expect(result.stageRevision.columns).toEqual(stageRevisionColumns)
    expect(result.strictTables).toEqual([
      { name: "qrspi_stage_revisions", strict: 1 },
      { name: "qrspi_stage_runs", strict: 1 },
    ])

    const runForeignKeys = groupForeignKeys(result.stageRun.foreignKeys)
    expect(runForeignKeys).toEqual([
      noActionForeignKey(
        0,
        "qrspi_stage_revisions",
        ["workflow_id", "generation", "stage_key", "run_ordinal", "accepted_revision"],
        ["workflow_id", "generation", "stage_key", "run_ordinal", "stage_revision"],
      ),
      noActionForeignKey(
        1,
        "qrspi_stage_revisions",
        ["workflow_id", "generation", "stage_key", "run_ordinal", "published_revision"],
        ["workflow_id", "generation", "stage_key", "run_ordinal", "stage_revision"],
      ),
      noActionForeignKey(
        2,
        "qrspi_stage_revisions",
        ["workflow_id", "generation", "stage_key", "run_ordinal", "pending_revision"],
        ["workflow_id", "generation", "stage_key", "run_ordinal", "stage_revision"],
      ),
      noActionForeignKey(
        3,
        "qrspi_stage_definitions",
        ["workflow_definition_sha256", "stage_definition_sha256", "stage_key"],
        ["workflow_definition_sha256", "stage_definition_sha256", "stage_key"],
      ),
      noActionForeignKey(
        4,
        "qrspi_generations",
        ["workflow_id", "generation", "workflow_definition_sha256"],
        ["workflow_id", "generation", "workflow_definition_sha256"],
      ),
    ])
    expect(groupForeignKeys(result.stageRevision.foreignKeys)).toEqual([
      noActionForeignKey(
        0,
        "qrspi_stage_runs",
        ["workflow_id", "generation", "stage_key", "run_ordinal"],
        ["workflow_id", "generation", "stage_key", "run_ordinal"],
      ),
    ])

    expect(result.runIndexes).toEqual([
      {
        name: "qrspi_stage_runs_current",
        unique: 1,
        partial: 1,
        origin: "c",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
          { name: "stage_key", seqno: 2 },
        ],
      },
      {
        name: "sqlite_autoindex_qrspi_stage_runs_1",
        unique: 1,
        partial: 0,
        origin: "pk",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
          { name: "stage_key", seqno: 2 },
          { name: "run_ordinal", seqno: 3 },
        ],
      },
    ])
    expect(compactDdl(result.currentDdl)).toBe(
      "CREATE UNIQUE INDEX qrspi_stage_runs_current ON qrspi_stage_runs (workflow_id, generation, stage_key) WHERE is_current = 1",
    )
    expect(result.stageDefinitionIndexes).toEqual([
      {
        name: "qrspi_stage_definitions_identity",
        unique: 1,
        partial: 0,
        origin: "c",
        columns: [
          { name: "workflow_definition_sha256", seqno: 0 },
          { name: "stage_definition_sha256", seqno: 1 },
          { name: "stage_key", seqno: 2 },
        ],
      },
      {
        name: "sqlite_autoindex_qrspi_stage_definitions_1",
        unique: 1,
        partial: 0,
        origin: "pk",
        columns: [
          { name: "workflow_definition_sha256", seqno: 0 },
          { name: "stage_definition_sha256", seqno: 1 },
        ],
      },
      {
        name: "sqlite_autoindex_qrspi_stage_definitions_2",
        unique: 1,
        partial: 0,
        origin: "u",
        columns: [
          { name: "workflow_definition_sha256", seqno: 0 },
          { name: "stage_key", seqno: 1 },
        ],
      },
      {
        name: "sqlite_autoindex_qrspi_stage_definitions_3",
        unique: 1,
        partial: 0,
        origin: "u",
        columns: [
          { name: "workflow_definition_sha256", seqno: 0 },
          { name: "sequence_position", seqno: 1 },
        ],
      },
    ])
    expect(result.revisionIndexes).toEqual([
      {
        name: "sqlite_autoindex_qrspi_stage_revisions_1",
        unique: 1,
        partial: 0,
        origin: "u",
        columns: [{ name: "owner_crossing_key", seqno: 0 }],
      },
      {
        name: "sqlite_autoindex_qrspi_stage_revisions_2",
        unique: 1,
        partial: 0,
        origin: "pk",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
          { name: "stage_key", seqno: 2 },
          { name: "stage_revision", seqno: 3 },
        ],
      },
      {
        name: "sqlite_autoindex_qrspi_stage_revisions_3",
        unique: 1,
        partial: 0,
        origin: "u",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
          { name: "stage_key", seqno: 2 },
          { name: "run_ordinal", seqno: 3 },
          { name: "stage_revision", seqno: 4 },
        ],
      },
      {
        name: "sqlite_autoindex_qrspi_stage_revisions_4",
        unique: 1,
        partial: 0,
        origin: "u",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
          { name: "stage_key", seqno: 2 },
          { name: "stage_revision", seqno: 3 },
          { name: "kind", seqno: 4 },
        ],
      },
    ])

    expect(result.stageRun.ddl).toContain("generation INTEGER NOT NULL CHECK (generation > 0)")
    expect(result.stageRun.ddl).toContain(
      "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
    )
    expect(result.stageRun.ddl).toContain(
      "run_ordinal INTEGER NOT NULL CHECK (run_ordinal BETWEEN 1 AND 1000000)",
    )
    for (const hash of ["workflow_definition_sha256", "stage_definition_sha256"]) {
      expect(result.stageRun.ddl).toContain(`length(${hash}) = 64`)
      expect(result.stageRun.ddl).toContain(`${hash} NOT GLOB '*[^0-9a-f]*'`)
    }
    expect(result.stageRun.ddl).toContain(
      "state TEXT NOT NULL CHECK (state IN (\n        'blocked', 'active', 'waiting_review', 'waiting_human', 'waiting_ticket',\n        'succeeded', 'skipped', 'rejected', 'failed', 'cancelled', 'superseded',\n        'data_error'\n      ))",
    )
    expect(result.stageRun.ddl).toContain(
      "is_current INTEGER NOT NULL CHECK (is_current IN (0, 1))",
    )
    expect(result.stageRun.ddl).toContain("json_valid(activation_policy_json) = 1")
    expect(result.stageRun.ddl).toContain("json_type(activation_policy_json, '$') = 'object'")
    expect(result.stageRun.ddl).toContain(
      "skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 2000",
    )
    for (const pointer of ["pending_revision", "published_revision", "accepted_revision"]) {
      expect(result.stageRun.ddl).toContain(
        `${pointer} IS NULL OR ${pointer} BETWEEN 1 AND 1000000`,
      )
    }
    expect(result.stageRun.ddl).toContain(
      "terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 2000",
    )
    expect(result.stageRevision.ddl).toContain("generation INTEGER NOT NULL CHECK (generation > 0)")
    expect(result.stageRevision.ddl).toContain(
      "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
    )
    expect(result.stageRevision.ddl).toContain(
      "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
    )
    expect(result.stageRevision.ddl).toContain(
      "run_ordinal INTEGER NOT NULL CHECK (run_ordinal BETWEEN 1 AND 1000000)",
    )
    expect(result.stageRevision.ddl).toContain(
      "kind TEXT NOT NULL CHECK (kind IN ('document', 'implementation'))",
    )
    expect(result.stageRevision.ddl).toContain(
      "state TEXT NOT NULL CHECK (state IN (\n        'producing', 'publishing', 'reviewing', 'waiting_human', 'accepted',\n        'abandoned', 'failed', 'superseded'\n      ))",
    )
    expect(result.stageRevision.ddl).toContain("length(owner_crossing_key) BETWEEN 1 AND 512")
    expect(result.stageRevision.ddl).toContain("json_valid(source_set_json) = 1")
    expect(result.stageRevision.ddl).toContain("json_type(source_set_json, '$') = 'array'")
    expect(result.stageRevision.ddl).toContain(
      "hash-bound ordered { role, artifact } identity projection",
    )
    expect(result.stageRevision.ddl).toContain("length(source_set_sha256) = 64")
    expect(result.stageRevision.ddl).toContain("source_set_sha256 NOT GLOB '*[^0-9a-f]*'")
  })

  test("creates the exact tagged payload, reference, diagnostic, and operation layout", async () => {
    const identity = ["workflow_id", "generation", "stage_key", "stage_revision"]
    const repository = ["provider_instance_id", "repository_id", "repository_full_name"]
    const column = (
      name: string,
      type: string,
      notnull: number,
      pk = 0,
      dflt_value: string | null = null,
    ): ColumnMetadata => ({ name, type, notnull, dflt_value, pk })
    const requiredIdentity = identity.map((name, index) =>
      column(
        name,
        name === "generation" || name === "stage_revision" ? "INTEGER" : "TEXT",
        1,
        index + 1,
      ),
    )
    const requiredRepository = repository.map((name) => column(name, "TEXT", 1))
    const timestamps = [column("created_at", "TEXT", 1), column("updated_at", "TEXT", 1)]
    const expected = {
      qrspi_document_stage_revisions: {
        columns: [
          ...requiredIdentity,
          column("kind", "TEXT", 1, 0, "'document'"),
          column("prepared_result_json", "TEXT", 0),
          column("prepared_result_sha256", "TEXT", 0),
          ...timestamps,
        ],
        foreignKeys: [
          noActionForeignKey(
            0,
            "qrspi_stage_revisions",
            [...identity, "kind"],
            [...identity, "kind"],
          ),
        ],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "kind = 'document'",
          "prepared_result_json IS NULL OR ( json_valid(prepared_result_json) = 1 AND json_type(prepared_result_json, '$') = 'object' )",
          "json_valid(prepared_result_json) = 1",
          "json_type(prepared_result_json, '$') = 'object'",
          "length(prepared_result_sha256) = 64",
          "prepared_result_sha256 NOT GLOB '*[^0-9a-f]*'",
          "(prepared_result_json IS NULL) = (prepared_result_sha256 IS NULL)",
        ],
      },
      qrspi_implementation_stage_revisions: {
        columns: [
          ...requiredIdentity,
          column("kind", "TEXT", 1, 0, "'implementation'"),
          column("prepared_delivery_evidence_json", "TEXT", 0),
          column("prepared_delivery_evidence_sha256", "TEXT", 0),
          ...timestamps,
        ],
        foreignKeys: [
          noActionForeignKey(
            0,
            "qrspi_stage_revisions",
            [...identity, "kind"],
            [...identity, "kind"],
          ),
        ],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "kind = 'implementation'",
          "prepared_delivery_evidence_json IS NULL OR ( json_valid(prepared_delivery_evidence_json) = 1 AND json_type(prepared_delivery_evidence_json, '$') = 'object' )",
          "json_valid(prepared_delivery_evidence_json) = 1",
          "json_type(prepared_delivery_evidence_json, '$') = 'object'",
          "length(prepared_delivery_evidence_sha256) = 64",
          "prepared_delivery_evidence_sha256 NOT GLOB '*[^0-9a-f]*'",
          "(prepared_delivery_evidence_json IS NULL) = (prepared_delivery_evidence_sha256 IS NULL)",
        ],
      },
      qrspi_implementation_steps: {
        columns: [
          ...requiredIdentity,
          column("position", "INTEGER", 1, 5),
          column("prepared_result_json", "TEXT", 0),
          column("prepared_result_sha256", "TEXT", 0),
          column("final", "INTEGER", 0),
          ...timestamps,
        ],
        foreignKeys: [
          noActionForeignKey(0, "qrspi_implementation_stage_revisions", identity, identity),
        ],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 1000000)",
          "prepared_result_json IS NULL OR ( json_valid(prepared_result_json) = 1 AND json_type(prepared_result_json, '$') = 'object' )",
          "json_valid(prepared_result_json) = 1",
          "json_type(prepared_result_json, '$') = 'object'",
          "length(prepared_result_sha256) = 64",
          "prepared_result_sha256 NOT GLOB '*[^0-9a-f]*'",
          "final INTEGER CHECK (final IN (0, 1))",
          "prepared_result_json IS NULL AND prepared_result_sha256 IS NULL AND final IS NULL",
          "prepared_result_json IS NOT NULL",
          "prepared_result_sha256 IS NOT NULL AND final IS NOT NULL",
        ],
      },
      qrspi_artifact_references: {
        columns: [
          ...requiredIdentity,
          ...requiredRepository,
          ...["commit_sha", "path", "blob_sha", "content_sha256", "media_type"].map((name) =>
            column(name, "TEXT", 1),
          ),
          ...timestamps,
        ],
        foreignKeys: [noActionForeignKey(0, "qrspi_document_stage_revisions", identity, identity)],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "length(provider_instance_id) BETWEEN 1 AND 128",
          "length(repository_id) BETWEEN 1 AND 128",
          "length(repository_full_name) BETWEEN 3 AND 256",
          "instr(repository_full_name, '/') > 0",
          "length(commit_sha) IN (40, 64)",
          "commit_sha NOT GLOB '*[^0-9a-f]*'",
          "length(path) BETWEEN 1 AND 512",
          "length(blob_sha) IN (40, 64)",
          "blob_sha NOT GLOB '*[^0-9a-f]*'",
          "length(content_sha256) = 64",
          "content_sha256 NOT GLOB '*[^0-9a-f]*'",
          "length(media_type) BETWEEN 1 AND 128",
        ],
      },
      qrspi_implementation_commit_references: {
        columns: [
          ...requiredIdentity,
          column("position", "INTEGER", 1, 5),
          ...requiredRepository,
          ...[
            "commit_sha",
            "expected_parent_sha",
            "changed_paths_json",
            "changed_paths_sha256",
          ].map((name) => column(name, "TEXT", 1)),
          ...timestamps,
        ],
        foreignKeys: [
          noActionForeignKey(
            0,
            "qrspi_implementation_steps",
            [...identity, "position"],
            [...identity, "position"],
          ),
        ],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 1000000)",
          "length(provider_instance_id) BETWEEN 1 AND 128",
          "length(repository_id) BETWEEN 1 AND 128",
          "length(repository_full_name) BETWEEN 3 AND 256",
          "instr(repository_full_name, '/') > 0",
          "length(commit_sha) IN (40, 64)",
          "commit_sha NOT GLOB '*[^0-9a-f]*'",
          "length(expected_parent_sha) IN (40, 64)",
          "expected_parent_sha NOT GLOB '*[^0-9a-f]*'",
          "json_valid(changed_paths_json) = 1",
          "json_type(changed_paths_json, '$') = 'array'",
          "json_array_length(changed_paths_json) > 0",
          "length(changed_paths_sha256) = 64",
          "changed_paths_sha256 NOT GLOB '*[^0-9a-f]*'",
        ],
      },
      qrspi_implementation_checkpoints: {
        columns: [
          ...requiredIdentity,
          column("checkpoint_id", "TEXT", 1),
          ...requiredRepository,
          ...[
            "base_sha",
            "final_sha",
            "commit_references_json",
            "commit_references_sha256",
            "changed_paths_json",
            "changed_paths_sha256",
            "prepared_delivery_evidence_sha256",
          ].map((name) => column(name, "TEXT", 1)),
          ...timestamps,
        ],
        foreignKeys: [
          noActionForeignKey(0, "qrspi_implementation_stage_revisions", identity, identity),
        ],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "checkpoint_id TEXT NOT NULL UNIQUE",
          "length(checkpoint_id) BETWEEN 1 AND 512",
          "length(provider_instance_id) BETWEEN 1 AND 128",
          "length(repository_id) BETWEEN 1 AND 128",
          "length(repository_full_name) BETWEEN 3 AND 256",
          "instr(repository_full_name, '/') > 0",
          "length(base_sha) IN (40, 64)",
          "base_sha NOT GLOB '*[^0-9a-f]*'",
          "length(final_sha) IN (40, 64)",
          "final_sha NOT GLOB '*[^0-9a-f]*'",
          "json_valid(commit_references_json) = 1",
          "json_type(commit_references_json, '$') = 'array'",
          "json_array_length(commit_references_json) > 0",
          "length(commit_references_sha256) = 64",
          "commit_references_sha256 NOT GLOB '*[^0-9a-f]*'",
          "json_valid(changed_paths_json) = 1",
          "json_type(changed_paths_json, '$') = 'array'",
          "json_array_length(changed_paths_json) > 0",
          "length(changed_paths_sha256) = 64",
          "changed_paths_sha256 NOT GLOB '*[^0-9a-f]*'",
          "length(prepared_delivery_evidence_sha256) = 64",
          "prepared_delivery_evidence_sha256 NOT GLOB '*[^0-9a-f]*'",
        ],
      },
      qrspi_stage_revision_diagnostics: {
        columns: [
          ...requiredIdentity,
          column("observed_kind", "TEXT", 0),
          column("observed_state", "TEXT", 0),
          column("reason", "TEXT", 1),
          column("message", "TEXT", 1),
          column("expected_json", "TEXT", 0),
          column("actual_json", "TEXT", 0),
          column("expected_sha256", "TEXT", 0),
          column("actual_sha256", "TEXT", 0),
          ...timestamps,
        ],
        foreignKeys: [noActionForeignKey(0, "qrspi_stage_revisions", identity, identity)],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "length(observed_kind) BETWEEN 1 AND 64",
          "length(observed_state) BETWEEN 1 AND 64",
          "length(message) BETWEEN 1 AND 2000",
          "expected_json IS NULL OR ( json_valid(expected_json) = 1 AND json_type(expected_json, '$') = 'object' )",
          "json_valid(expected_json) = 1",
          "json_type(expected_json, '$') = 'object'",
          "actual_json IS NULL OR ( json_valid(actual_json) = 1 AND json_type(actual_json, '$') = 'object' )",
          "json_valid(actual_json) = 1",
          "json_type(actual_json, '$') = 'object'",
          "length(expected_sha256) = 64",
          "expected_sha256 NOT GLOB '*[^0-9a-f]*'",
          "length(actual_sha256) = 64",
          "actual_sha256 NOT GLOB '*[^0-9a-f]*'",
        ],
      },
      qrspi_stage_operation_owners: {
        columns: [
          column("operation_id", "TEXT", 1, 1),
          column("operation_kind", "TEXT", 1),
          column("owner_kind", "TEXT", 1),
          column("operation_role", "TEXT", 1),
          column("created_at", "TEXT", 1),
        ],
        foreignKeys: [
          noActionForeignKey(
            0,
            "workflow_operations",
            ["operation_id", "operation_kind"],
            ["operation_id", "kind"],
          ),
        ],
        ddl: [
          "operation_kind IN ('StageProduce', 'ArtifactPublish')",
          "owner_kind IN ('document_revision', 'implementation_step')",
          "operation_role TEXT NOT NULL CHECK (operation_role IN ('produce', 'publish'))",
          "operation_role = 'produce' AND operation_kind = 'StageProduce'",
          "operation_role = 'publish' AND operation_kind = 'ArtifactPublish'",
          "UNIQUE (operation_id, owner_kind, operation_role)",
        ],
      },
      qrspi_document_stage_revision_operations: {
        columns: [
          ...requiredIdentity,
          column("owner_kind", "TEXT", 1, 0, "'document_revision'"),
          column("operation_role", "TEXT", 1, 5),
          column("operation_id", "TEXT", 1),
          ...timestamps,
        ],
        foreignKeys: [
          noActionForeignKey(
            0,
            "qrspi_stage_operation_owners",
            ["operation_id", "owner_kind", "operation_role"],
            ["operation_id", "owner_kind", "operation_role"],
          ),
          noActionForeignKey(1, "qrspi_document_stage_revisions", identity, identity),
        ],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "owner_kind = 'document_revision'",
          "operation_role IN ('produce', 'publish')",
          "UNIQUE (operation_id)",
        ],
      },
      qrspi_implementation_step_operations: {
        columns: [
          ...requiredIdentity,
          column("position", "INTEGER", 1, 5),
          column("owner_kind", "TEXT", 1, 0, "'implementation_step'"),
          column("operation_role", "TEXT", 1, 6),
          column("operation_id", "TEXT", 1),
          ...timestamps,
        ],
        foreignKeys: [
          noActionForeignKey(
            0,
            "qrspi_stage_operation_owners",
            ["operation_id", "owner_kind", "operation_role"],
            ["operation_id", "owner_kind", "operation_role"],
          ),
          noActionForeignKey(
            1,
            "qrspi_implementation_steps",
            [...identity, "position"],
            [...identity, "position"],
          ),
        ],
        ddl: [
          "generation INTEGER NOT NULL CHECK (generation > 0)",
          "stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64)",
          "stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000)",
          "position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 1000000)",
          "owner_kind = 'implementation_step'",
          "operation_role IN ('produce', 'publish')",
          "UNIQUE (operation_id)",
        ],
      },
    } as const

    expect(expected.qrspi_document_stage_revisions.ddl).toContain(
      "json_valid(prepared_result_json) = 1",
    )
    expect(expected.qrspi_implementation_stage_revisions.ddl).toContain(
      "json_valid(prepared_delivery_evidence_json) = 1",
    )
    expect(expected.qrspi_implementation_steps.ddl).toContain(
      "json_valid(prepared_result_json) = 1",
    )
    expect(expected.qrspi_implementation_commit_references.ddl).toContain(
      "json_valid(changed_paths_json) = 1",
    )
    expect(expected.qrspi_implementation_checkpoints.ddl).toContain(
      "json_valid(commit_references_json) = 1",
    )
    expect(expected.qrspi_implementation_checkpoints.ddl).toContain(
      "json_valid(changed_paths_json) = 1",
    )
    expect(expected.qrspi_stage_revision_diagnostics.ddl).toContain("json_valid(expected_json) = 1")
    expect(expected.qrspi_stage_revision_diagnostics.ddl).toContain("json_valid(actual_json) = 1")
    expect(expected.qrspi_document_stage_revisions.ddl).toContain(
      "prepared_result_json IS NULL OR ( json_valid(prepared_result_json) = 1 AND json_type(prepared_result_json, '$') = 'object' )",
    )
    expect(expected.qrspi_implementation_stage_revisions.ddl).toContain(
      "prepared_delivery_evidence_json IS NULL OR ( json_valid(prepared_delivery_evidence_json) = 1 AND json_type(prepared_delivery_evidence_json, '$') = 'object' )",
    )
    expect(expected.qrspi_implementation_steps.ddl).toContain(
      "prepared_result_json IS NULL OR ( json_valid(prepared_result_json) = 1 AND json_type(prepared_result_json, '$') = 'object' )",
    )
    expect(expected.qrspi_stage_revision_diagnostics.ddl).toContain(
      "expected_json IS NULL OR ( json_valid(expected_json) = 1 AND json_type(expected_json, '$') = 'object' )",
    )
    expect(expected.qrspi_stage_revision_diagnostics.ddl).toContain(
      "actual_json IS NULL OR ( json_valid(actual_json) = 1 AND json_type(actual_json, '$') = 'object' )",
    )

    const result = await runWithDatabase(
      Effect.gen(function* () {
        const tables = yield* Effect.all(
          Object.keys(expected).map((table) =>
            readTableMetadata(table).pipe(Effect.map((metadata) => [table, metadata] as const)),
          ),
        )
        const strictTables = yield* SqlClient.SqlClient.pipe(
          Effect.flatMap((sql) =>
            sql.unsafe<{ readonly name: string; readonly strict: number }>(
              `SELECT name, strict FROM pragma_table_list
               WHERE name IN (${Object.keys(expected)
                 .map(() => "?")
                 .join(", ")}) ORDER BY name`,
              Object.keys(expected),
            ),
          ),
        )
        return { strictTables, tables: Object.fromEntries(tables) }
      }),
    )

    expect(result.strictTables).toEqual(
      Object.keys(expected)
        .sort()
        .map((name) => ({ name, strict: 1 })),
    )
    for (const [table, inventory] of Object.entries(expected)) {
      const metadata = result.tables[table]!
      expect(metadata.columns, table).toEqual(inventory.columns)
      expect(groupForeignKeys(metadata.foreignKeys), table).toEqual([...inventory.foreignKeys])
      for (const snippet of inventory.ddl) {
        expect(compactDdl(metadata.ddl), `${table}: ${snippet}`).toContain(compactDdl(snippet))
      }
    }
    const diagnosticDdl = result.tables.qrspi_stage_revision_diagnostics!.ddl!
    const reasonClause = diagnosticDdl.match(/reason TEXT NOT NULL CHECK \(reason IN \((.*?)\)\)/s)
    expect(reasonClause?.[1]).toBeDefined()
    expect(
      Array.from(reasonClause?.[1]?.matchAll(/'([^']+)'/g) ?? [], (match) => match[1]),
    ).toEqual([
      "malformed",
      "missing",
      "duplicate",
      "reordered",
      "hash_mismatch",
      "identity_mismatch",
    ])
  })

  test("installs the exact runtime indexes", async () => {
    const identityColumns = (length: number) =>
      ["workflow_id", "generation", "stage_key", "stage_revision", "position"].slice(0, length)
    const expectedAuthorityIndexes = {
      qrspi_document_stage_revisions: [
        ["sqlite_autoindex_qrspi_document_stage_revisions_1", 1, "pk", ...identityColumns(4)],
      ],
      qrspi_implementation_stage_revisions: [
        ["sqlite_autoindex_qrspi_implementation_stage_revisions_1", 1, "pk", ...identityColumns(4)],
      ],
      qrspi_implementation_steps: [
        ["sqlite_autoindex_qrspi_implementation_steps_1", 1, "pk", ...identityColumns(5)],
      ],
      qrspi_artifact_references: [
        ["sqlite_autoindex_qrspi_artifact_references_1", 1, "pk", ...identityColumns(4)],
      ],
      qrspi_implementation_commit_references: [
        [
          "sqlite_autoindex_qrspi_implementation_commit_references_1",
          1,
          "pk",
          ...identityColumns(5),
        ],
      ],
      qrspi_implementation_checkpoints: [
        ["sqlite_autoindex_qrspi_implementation_checkpoints_1", 1, "u", "checkpoint_id"],
        ["sqlite_autoindex_qrspi_implementation_checkpoints_2", 1, "pk", ...identityColumns(4)],
      ],
      qrspi_stage_revision_diagnostics: [
        ["sqlite_autoindex_qrspi_stage_revision_diagnostics_1", 1, "pk", ...identityColumns(4)],
      ],
      qrspi_stage_operation_owners: [
        ["qrspi_stage_operation_owners_role", 0, "c", "operation_role", "operation_id"],
        ["sqlite_autoindex_qrspi_stage_operation_owners_1", 1, "pk", "operation_id"],
        [
          "sqlite_autoindex_qrspi_stage_operation_owners_2",
          1,
          "u",
          "operation_id",
          "owner_kind",
          "operation_role",
        ],
      ],
      qrspi_document_stage_revision_operations: [
        [
          "sqlite_autoindex_qrspi_document_stage_revision_operations_1",
          1,
          "pk",
          ...identityColumns(4),
          "operation_role",
        ],
        ["sqlite_autoindex_qrspi_document_stage_revision_operations_2", 1, "u", "operation_id"],
      ],
      qrspi_implementation_step_operations: [
        [
          "sqlite_autoindex_qrspi_implementation_step_operations_1",
          1,
          "pk",
          ...identityColumns(5),
          "operation_role",
        ],
        ["sqlite_autoindex_qrspi_implementation_step_operations_2", 1, "u", "operation_id"],
      ],
    } as const
    const result = await runWithDatabase(
      Effect.gen(function* () {
        const authorityIndexes = yield* Effect.all(
          Object.keys(expectedAuthorityIndexes).map((table) =>
            readTableMetadata(table).pipe(
              Effect.flatMap(({ indexes }) => readIndexInventory(indexes)),
              Effect.map((indexes) => [table, indexes] as const),
            ),
          ),
        )
        const workflowOperation = yield* readTableMetadata("workflow_operations")
        return {
          authorityIndexes: Object.fromEntries(authorityIndexes),
          workflowOperationIndexes: yield* readIndexInventory(workflowOperation.indexes),
        }
      }),
    )

    for (const [table, indexes] of Object.entries(expectedAuthorityIndexes)) {
      expect(result.authorityIndexes[table], table).toEqual(
        indexes.map(([name, unique, origin, ...columns]) => ({
          name,
          unique,
          partial: 0,
          origin,
          columns: columns.map((name, seqno) => ({ name, seqno })),
        })),
      )
    }
    expect(result.workflowOperationIndexes).toContainEqual({
      name: "workflow_operations_identity_kind",
      unique: 1,
      partial: 0,
      origin: "c",
      columns: [
        { name: "operation_id", seqno: 0 },
        { name: "kind", seqno: 1 },
      ],
    })
  })

  test("installs no runtime facts, triggers, or executable claim indexes", async () => {
    const result = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const counts = yield* Effect.all(
          runtimeTables.map((table) =>
            sql.unsafe<{ readonly count: number }>(`SELECT count(*) AS count FROM "${table}"`),
          ),
        )
        const triggers = yield* sql.unsafe(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND (
             ${runtimeTables.map((table) => `lower(sql) LIKE '%${table}%'`).join(" OR ")}
             OR lower(sql) LIKE '%current_stage_run_ordinal%'
           )`,
        )
        const claimIndexes = yield* sql.unsafe(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND tbl_name IN (${runtimeTables.map((table) => `'${table}'`).join(", ")})
             AND (
               lower(name) LIKE '%claim%' OR lower(coalesce(sql, '')) LIKE '%claim%'
               OR lower(name) LIKE '%lease%' OR lower(coalesce(sql, '')) LIKE '%lease%'
               OR lower(name) LIKE '%run_at%' OR lower(coalesce(sql, '')) LIKE '%run_at%'
             )`,
        )
        return { claimIndexes, counts, triggers }
      }),
    )

    expect(result.counts.flat()).toEqual(runtimeTables.map(() => ({ count: 0 })))
    expect(result.triggers).toEqual([])
    expect(result.claimIndexes).toEqual([])
  })
})

describe("migration 9: qrspi_stage_definitions strict table", () => {
  test("creates strict table with SHA-256 primary key validation", async () => {
    const result = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const tableInfo = yield* sql`
          SELECT name, pk
          FROM pragma_table_info('qrspi_stage_definitions')
          WHERE name = 'stage_definition_sha256'
        `
        const table = yield* sql`
          SELECT strict FROM pragma_table_list WHERE name = 'qrspi_stage_definitions'
        `
        const foreignKeys = yield* sql`
          SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'qrspi_stage_definitions'
        `
        return { table, tableInfo, foreignKeys }
      }),
    )

    expect(result.tableInfo).toHaveLength(1)
    expect(result.tableInfo[0]?.name).toBe("stage_definition_sha256")
    expect(result.table).toEqual([{ strict: 1 }])
    expect(result.foreignKeys[0]?.sql).toContain("STRICT")
    expect(result.foreignKeys[0]?.sql).toContain("PRIMARY KEY")
    expect(result.foreignKeys[0]?.sql).toContain("length(stage_definition_sha256) = 64")
    expect(result.foreignKeys[0]?.sql).toContain("stage_definition_sha256 NOT GLOB '*[^0-9a-f]*'")
  })

  test("enforces workflow_definition foreign key constraint", async () => {
    const wasRejected = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        return yield* rejected(sql`
          INSERT INTO qrspi_stage_definitions (
            stage_definition_sha256,
            workflow_definition_sha256,
            stage_key,
            sequence_position,
            definition_json,
            contract_name,
            contract_version,
            contract_registration_sha256,
            harness_name,
            harness_version,
            harness_registration_sha256,
            created_at
          ) VALUES (
            ${"a".repeat(64)},
            ${"b".repeat(64)},
            'test-stage',
            1,
            '{}',
            'test-contract',
            1,
            ${"c".repeat(64)},
            'opencode',
            1,
            ${"d".repeat(64)},
            '2026-07-21T05:00:00.000Z'
          )
        `)
      }),
    )

    expect(wasRejected).toBe(true)
  })

  test("validates JSON object structure in definition_json", async () => {
    const wasRejected = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        // First insert a valid workflow definition
        yield* sql`
          INSERT INTO qrspi_workflow_definitions (
            definition_sha256,
            definition_json,
            created_at
          ) VALUES (
            ${"b".repeat(64)},
            '{}',
            '2026-07-21T05:00:00.000Z'
          )
        `
        yield* sql`PRAGMA foreign_keys = OFF`
        return yield* rejected(sql`
          INSERT INTO qrspi_stage_definitions (
            stage_definition_sha256,
            workflow_definition_sha256,
            stage_key,
            sequence_position,
            definition_json,
            contract_name,
            contract_version,
            contract_registration_sha256,
            harness_name,
            harness_version,
            harness_registration_sha256,
            created_at
          ) VALUES (
            ${"a".repeat(64)},
            ${"b".repeat(64)},
            'test-stage',
            1,
            'not-a-json-object',
            'test-contract',
            1,
            ${"c".repeat(64)},
            'opencode',
            1,
            ${"d".repeat(64)},
            '2026-07-21T05:00:00.000Z'
          )
        `)
      }),
    )

    expect(wasRejected).toBe(true)
  })

  test("enforces stage_key length and sequence_position constraints", async () => {
    const results = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO qrspi_workflow_definitions (
            definition_sha256,
            definition_json,
            created_at
          ) VALUES (
            ${"b".repeat(64)},
            '{}',
            '2026-07-21T05:00:00.000Z'
          )
        `
        yield* sql`PRAGMA foreign_keys = OFF`
        return yield* Effect.all([
          rejected(sql`
            INSERT INTO qrspi_stage_definitions (
              stage_definition_sha256,
              workflow_definition_sha256,
              stage_key,
              sequence_position,
              definition_json,
              contract_name,
              contract_version,
              contract_registration_sha256,
              harness_name,
              harness_version,
              harness_registration_sha256,
              created_at
            ) VALUES (
              ${"a".repeat(64)},
              ${"b".repeat(64)},
              '',
              1,
              '{}',
              'test-contract',
              1,
              ${"c".repeat(64)},
              'opencode',
              1,
              ${"d".repeat(64)},
              '2026-07-21T05:00:00.000Z'
            )
          `),
          rejected(sql`
            INSERT INTO qrspi_stage_definitions (
              stage_definition_sha256,
              workflow_definition_sha256,
              stage_key,
              sequence_position,
              definition_json,
              contract_name,
              contract_version,
              contract_registration_sha256,
              harness_name,
              harness_version,
              harness_registration_sha256,
              created_at
            ) VALUES (
              ${"e".repeat(64)},
              ${"b".repeat(64)},
              'test-stage',
              0,
              '{}',
              'test-contract',
              1,
              ${"c".repeat(64)},
              'opencode',
              1,
              ${"d".repeat(64)},
              '2026-07-21T05:00:00.000Z'
            )
          `),
        ])
      }),
    )

    expect(results).toEqual([true, true])
  })

  test("enforces workflow-scoped key and order uniqueness", async () => {
    const wasRejected = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const workflowSha256 = "b".repeat(64)
        yield* sql`
          INSERT INTO qrspi_workflow_definitions (
            definition_sha256,
            definition_json,
            created_at
          ) VALUES (${workflowSha256}, '{}', '2026-07-21T05:00:00.000Z')
        `
        yield* sql`
          INSERT INTO qrspi_stage_definitions (
            stage_definition_sha256,
            workflow_definition_sha256,
            stage_key,
            sequence_position,
            definition_json,
            contract_name,
            contract_version,
            contract_registration_sha256,
            harness_name,
            harness_version,
            harness_registration_sha256,
            created_at
          ) VALUES (
            ${"a".repeat(64)},
            ${workflowSha256},
            'test-stage',
            1,
            '{}',
            'test-contract',
            1,
            ${"c".repeat(64)},
            'opencode',
            1,
            ${"d".repeat(64)},
            '2026-07-21T05:00:00.000Z'
          )
        `
        return yield* rejected(sql`
          INSERT INTO qrspi_stage_definitions (
            stage_definition_sha256,
            workflow_definition_sha256,
            stage_key,
            sequence_position,
            definition_json,
            contract_name,
            contract_version,
            contract_registration_sha256,
            harness_name,
            harness_version,
            harness_registration_sha256,
            created_at
          ) VALUES (
            ${"e".repeat(64)},
            ${workflowSha256},
            'test-stage',
            2,
            '{}',
            'test-contract',
            1,
            ${"c".repeat(64)},
            'opencode',
            1,
            ${"d".repeat(64)},
            '2026-07-21T05:00:00.000Z'
          )
        `)
      }),
    )

    expect(wasRejected).toBe(true)
  })
})

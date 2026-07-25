import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  const runtimeGraphOrder = {
    qrspi_workflows: "workflow_id",
    qrspi_ticket_revisions: "workflow_id, ticket_revision_sha256",
    qrspi_workflow_definitions: "definition_sha256",
    qrspi_stage_definitions: "workflow_definition_sha256, stage_definition_sha256",
    qrspi_generations: "workflow_id, generation",
    workflow_operations: "logical_operation_id, operation_revision, operation_id",
    qrspi_stage_runs: "workflow_id, generation, stage_key, run_ordinal",
    qrspi_stage_revisions: "workflow_id, generation, stage_key, stage_revision",
    qrspi_document_stage_revisions: "workflow_id, generation, stage_key, stage_revision",
    qrspi_implementation_stage_revisions: "workflow_id, generation, stage_key, stage_revision",
    qrspi_implementation_steps: "workflow_id, generation, stage_key, stage_revision, position",
    qrspi_artifact_references: "workflow_id, generation, stage_key, stage_revision",
    qrspi_implementation_commit_references:
      "workflow_id, generation, stage_key, stage_revision, position",
    qrspi_implementation_checkpoints: "workflow_id, generation, stage_key, stage_revision",
    qrspi_stage_revision_diagnostics: "workflow_id, generation, stage_key, stage_revision",
    qrspi_stage_operation_owners: "operation_id",
    qrspi_document_stage_revision_operations:
      "workflow_id, generation, stage_key, stage_revision, operation_role",
    qrspi_implementation_step_operations:
      "workflow_id, generation, stage_key, stage_revision, position, operation_role",
  } as const

  const readRuntimeGraph = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const entries = yield* Effect.all(
      Object.entries(runtimeGraphOrder).map(([table, orderBy]) =>
        sql
          .unsafe<Record<string, unknown>>(`SELECT * FROM "${table}" ORDER BY ${orderBy}`)
          .pipe(Effect.map((rows) => [table, rows] as const)),
      ),
      { concurrency: 1 },
    )
    return Object.fromEntries(entries)
  })

  const runtimeFixture = {
    workflowId: "workflow-runtime-identity",
    ticketRevisionSha256: "1".repeat(64),
    workflowDefinitionSha256: "2".repeat(64),
    documentStageDefinitionSha256: "3".repeat(64),
    implementationStageDefinitionSha256: "4".repeat(64),
    documentStageKey: "research",
    implementationStageKey: "implementation",
    historicalRunOrdinal: 1,
    currentRunOrdinal: 2,
    otherGenerationRunOrdinal: 3,
    historicalRevision: 1,
    pendingRevision: 2,
    publishedRevision: 3,
    acceptedRevision: 4,
    implementationStepPosition: 1,
    documentPreparedResultJson: '{"result":"document-ready"}',
    documentPreparedResultSha256: "1".repeat(64),
    implementationEvidenceJson: '{"result":"implementation-ready"}',
    implementationEvidenceSha256: "2".repeat(64),
    stepPreparedResultJson: '{"result":"step-ready"}',
    stepPreparedResultSha256: "3".repeat(64),
    documentProduceOperationId: "runtime-document-produce-r1",
    documentPublishOperationId: "runtime-document-publish-r1",
    implementationProduceOperationId: "runtime-implementation-produce-r1",
    implementationPublishOperationId: "runtime-implementation-publish-r1",
  } as const

  const insertRuntimeOperation = (
    operationId: string,
    kind: "StageProduce" | "ArtifactPublish" | "ReviewContribute",
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO workflow_operations (
          operation_id, logical_operation_id, operation_revision, retry_of, kind,
          scope_json, input_json, input_sha256, output_json, state, is_current,
          attempt, max_attempts, lease_owner, lease_token, lease_until, run_at,
          external_intent_json, external_observation_json, observation_attempts,
          max_observation_attempts, parent_effect_json, last_error,
          terminal_failure_reason, terminal_retry_policy, created_at, updated_at
        ) VALUES (
          ${operationId}, ${operationId}, 1, NULL, ${kind}, '{}', '{}',
          ${"6".repeat(64)}, NULL, 'ready', 1, 0, 3, NULL, NULL, NULL,
          ${timestamp}, NULL, NULL, 0, 3, '{}', NULL, NULL, NULL,
          ${timestamp}, ${timestamp}
        )
      `
    })

  const insertRuntimeOperationOwner = (
    operationId: string,
    operationKind: "StageProduce" | "ArtifactPublish",
    ownerKind: "document_revision" | "implementation_step",
    operationRole: "produce" | "publish",
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* insertRuntimeOperation(operationId, operationKind)
      yield* sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          ${operationId}, ${operationKind}, ${ownerKind}, ${operationRole}, ${timestamp}
        )
      `
    })

  const insertSecondImplementationStep = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO qrspi_implementation_steps (
        workflow_id, generation, stage_key, stage_revision, position,
        prepared_result_json, prepared_result_sha256, final, created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1, 2,
        NULL, NULL, NULL, ${timestamp}, ${timestamp}
      )
    `
  })

  const seedValidRuntimeIdentitySpine = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`
      INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
      VALUES (${runtimeFixture.workflowId}, 'workflow/runtime-identity', ${timestamp}, ${timestamp})
    `
    yield* sql`
      INSERT INTO qrspi_ticket_revisions (
        workflow_id, ticket_revision_sha256, revision_json, checked_at
      ) VALUES (
        ${runtimeFixture.workflowId}, ${runtimeFixture.ticketRevisionSha256},
        '{"ticket":"runtime identity"}', ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_workflow_definitions (
        definition_sha256, definition_json, created_at
      ) VALUES (
        ${runtimeFixture.workflowDefinitionSha256},
        '{"workflow":"runtime identity"}', ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_stage_definitions (
        stage_definition_sha256, workflow_definition_sha256, stage_key,
        sequence_position, definition_json, contract_name, contract_version,
        contract_registration_sha256, harness_name, harness_version,
        harness_registration_sha256, created_at
      ) VALUES
        (
          ${runtimeFixture.documentStageDefinitionSha256},
          ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.documentStageKey}, 1, '{"kind":"document"}',
          'DocumentStage', 1, ${"5".repeat(64)}, 'opencode', 1,
          ${"6".repeat(64)}, ${timestamp}
        ),
        (
          ${runtimeFixture.implementationStageDefinitionSha256},
          ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.implementationStageKey}, 2,
          '{"kind":"implementation"}', 'ImplementationStage', 1,
          ${"7".repeat(64)}, 'opencode', 1, ${"8".repeat(64)}, ${timestamp}
        )
    `
    yield* sql`
      INSERT INTO qrspi_generations (
        workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
        root_sha, current_head_sha, ticket_revision_sha256,
        workflow_definition_sha256, state, is_current, created_at, updated_at,
        generation_format, current_stage_key, current_stage_run_ordinal
      ) VALUES
        (
          ${runtimeFixture.workflowId}, 1, '{"repository":"runtime"}', 'main',
          ${"a".repeat(40)}, 'workflow/runtime-identity', ${"b".repeat(40)},
          ${"c".repeat(40)}, ${runtimeFixture.ticketRevisionSha256},
          ${runtimeFixture.workflowDefinitionSha256}, 'running', 1,
          ${timestamp}, ${timestamp}, 'stage_runtime_v1', NULL, NULL
        ),
        (
          ${runtimeFixture.workflowId}, 2, '{"repository":"runtime"}', 'main',
          ${"d".repeat(40)}, 'workflow/runtime-identity-next', ${"e".repeat(40)},
          ${"f".repeat(40)}, ${runtimeFixture.ticketRevisionSha256},
          ${runtimeFixture.workflowDefinitionSha256}, 'superseded', 0,
          ${timestamp}, ${timestamp}, 'stage_runtime_v1', NULL, NULL
        )
    `
    yield* sql`
      INSERT INTO workflow_operations (
        operation_id, logical_operation_id, operation_revision, retry_of, kind,
        scope_json, input_json, input_sha256, output_json, state, is_current,
        attempt, max_attempts, lease_owner, lease_token, lease_until, run_at,
        external_intent_json, external_observation_json, observation_attempts,
        max_observation_attempts, parent_effect_json, last_error,
        terminal_failure_reason, terminal_retry_policy, created_at, updated_at
      ) VALUES
        (
          ${runtimeFixture.documentProduceOperationId}, 'runtime-document-produce', 1,
          NULL, 'StageProduce',
          '{"stage":"research"}', '{"request":"produce"}', ${"9".repeat(64)},
          NULL, 'ready', 1, 0, 3, NULL, NULL, NULL, ${timestamp}, NULL, NULL,
          0, 3, '{}', NULL, NULL, NULL, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.documentPublishOperationId}, 'runtime-document-publish', 1,
          NULL, 'ArtifactPublish',
          '{"stage":"research"}', '{"request":"publish"}', ${"a".repeat(64)},
          NULL, 'ready', 1, 0, 3, NULL, NULL, NULL, ${timestamp}, NULL, NULL,
          0, 3, '{}', NULL, NULL, NULL, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.implementationProduceOperationId},
          'runtime-implementation-produce', 1, NULL, 'StageProduce',
          '{"stage":"implementation"}', '{"request":"produce"}',
          ${"4".repeat(64)}, NULL, 'ready', 1, 0, 3, NULL, NULL, NULL,
          ${timestamp}, NULL, NULL, 0, 3, '{}', NULL, NULL, NULL,
          ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.implementationPublishOperationId},
          'runtime-implementation-publish', 1, NULL, 'ArtifactPublish',
          '{"stage":"implementation"}', '{"request":"publish"}',
          ${"5".repeat(64)}, NULL, 'ready', 1, 0, 3, NULL, NULL, NULL,
          ${timestamp}, NULL, NULL, 0, 3, '{}', NULL, NULL, NULL,
          ${timestamp}, ${timestamp}
        )
    `
    yield* sql`
      INSERT INTO qrspi_stage_runs (
        workflow_id, generation, stage_key, run_ordinal,
        workflow_definition_sha256, stage_definition_sha256, state, is_current,
        activation_policy_json, pending_revision, published_revision,
        accepted_revision, created_at, updated_at
      ) VALUES
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.historicalRunOrdinal},
          ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.documentStageDefinitionSha256}, 'succeeded', 0, '{}',
          NULL, NULL, NULL, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.currentRunOrdinal},
          ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.documentStageDefinitionSha256}, 'active', 1, '{}',
          NULL, NULL, NULL, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.implementationStageDefinitionSha256}, 'blocked', 1, '{}',
          NULL, NULL, NULL, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.workflowId}, 2, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.otherGenerationRunOrdinal},
          ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.documentStageDefinitionSha256}, 'blocked', 1, '{}',
          NULL, NULL, NULL, ${timestamp}, ${timestamp}
        )
    `
    yield* sql`
      INSERT INTO qrspi_stage_revisions (
        workflow_id, generation, stage_key, stage_revision, run_ordinal, kind,
        state, owner_crossing_key, source_set_json, source_set_sha256,
        created_at, updated_at
      ) VALUES
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.historicalRevision}, ${runtimeFixture.historicalRunOrdinal},
          'document', 'accepted', 'owner-research-historical', '[]',
          ${"b".repeat(64)}, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.pendingRevision}, ${runtimeFixture.currentRunOrdinal},
          'document', 'producing', 'owner-research-pending', '[]',
          ${"c".repeat(64)}, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.publishedRevision}, ${runtimeFixture.currentRunOrdinal},
          'document', 'publishing', 'owner-research-published', '[]',
          ${"d".repeat(64)}, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, ${runtimeFixture.currentRunOrdinal},
          'document', 'accepted', 'owner-research-accepted', '[]',
          ${"e".repeat(64)}, ${timestamp}, ${timestamp}
        ),
        (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey},
          1, 1, 'implementation', 'producing', 'owner-implementation-pending', '[]',
          ${"f".repeat(64)}, ${timestamp}, ${timestamp}
        )
    `
    yield* sql`
      INSERT INTO qrspi_document_stage_revisions (
        workflow_id, generation, stage_key, stage_revision, kind,
        prepared_result_json, prepared_result_sha256, created_at, updated_at
      ) VALUES
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 1,
          'document', NULL, NULL, ${timestamp}, ${timestamp}),
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 2,
          'document', NULL, NULL, ${timestamp}, ${timestamp}),
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 3,
          'document', NULL, NULL, ${timestamp}, ${timestamp}),
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 4,
          'document', ${runtimeFixture.documentPreparedResultJson},
          ${runtimeFixture.documentPreparedResultSha256}, ${timestamp}, ${timestamp})
    `
    yield* sql`
      INSERT INTO qrspi_implementation_stage_revisions (
        workflow_id, generation, stage_key, stage_revision, kind,
        prepared_delivery_evidence_json, prepared_delivery_evidence_sha256,
        created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
        'implementation', ${runtimeFixture.implementationEvidenceJson},
        ${runtimeFixture.implementationEvidenceSha256}, ${timestamp}, ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_implementation_steps (
        workflow_id, generation, stage_key, stage_revision, position,
        prepared_result_json, prepared_result_sha256, final, created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
        ${runtimeFixture.implementationStepPosition},
        ${runtimeFixture.stepPreparedResultJson},
        ${runtimeFixture.stepPreparedResultSha256}, 1, ${timestamp}, ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_artifact_references (
        workflow_id, generation, stage_key, stage_revision,
        provider_instance_id, repository_id, repository_full_name,
        commit_sha, path, blob_sha, content_sha256, media_type,
        created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
        ${runtimeFixture.acceptedRevision}, 'github.com', 'repository-42',
        'example/workflowd', ${"4".repeat(40)}, 'artifacts/research.md',
        ${"5".repeat(40)}, ${"6".repeat(64)}, 'text/markdown',
        ${timestamp}, ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_implementation_commit_references (
        workflow_id, generation, stage_key, stage_revision, position,
        provider_instance_id, repository_id, repository_full_name,
        commit_sha, expected_parent_sha, changed_paths_json,
        changed_paths_sha256, created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
        ${runtimeFixture.implementationStepPosition}, 'github.com', 'repository-42',
        'example/workflowd', ${"4".repeat(40)}, ${"5".repeat(40)},
        '["src/main.ts"]', ${"6".repeat(64)}, ${timestamp}, ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_implementation_checkpoints (
        workflow_id, generation, stage_key, stage_revision, checkpoint_id,
        provider_instance_id, repository_id, repository_full_name,
        base_sha, final_sha, commit_references_json, commit_references_sha256,
        changed_paths_json, changed_paths_sha256,
        prepared_delivery_evidence_sha256, created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
        'runtime-implementation-checkpoint', 'github.com', 'repository-42',
        'example/workflowd', ${"5".repeat(40)}, ${"4".repeat(40)},
        '[{"position":1}]', ${"7".repeat(64)}, '["src/main.ts"]',
        ${"6".repeat(64)}, ${runtimeFixture.implementationEvidenceSha256},
        ${timestamp}, ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_stage_revision_diagnostics (
        workflow_id, generation, stage_key, stage_revision,
        observed_kind, observed_state, reason, message,
        expected_json, actual_json, expected_sha256, actual_sha256,
        created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
        ${runtimeFixture.historicalRevision}, 'document', 'accepted',
        'identity_mismatch', 'Fixture diagnostic for the historical revision.',
        '{"kind":"document"}', '{"kind":"implementation"}',
        ${"8".repeat(64)}, ${"9".repeat(64)}, ${timestamp}, ${timestamp}
      )
    `
    yield* sql`
      INSERT INTO qrspi_stage_operation_owners (
        operation_id, operation_kind, owner_kind, operation_role, created_at
      ) VALUES
        (${runtimeFixture.documentProduceOperationId}, 'StageProduce',
          'document_revision', 'produce', ${timestamp}),
        (${runtimeFixture.documentPublishOperationId}, 'ArtifactPublish',
          'document_revision', 'publish', ${timestamp}),
        (${runtimeFixture.implementationProduceOperationId}, 'StageProduce',
          'implementation_step', 'produce', ${timestamp}),
        (${runtimeFixture.implementationPublishOperationId}, 'ArtifactPublish',
          'implementation_step', 'publish', ${timestamp})
    `
    yield* sql`
      INSERT INTO qrspi_document_stage_revision_operations (
        workflow_id, generation, stage_key, stage_revision,
        owner_kind, operation_role, operation_id, created_at, updated_at
      ) VALUES
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document_revision', 'produce',
          ${runtimeFixture.documentProduceOperationId}, ${timestamp}, ${timestamp}),
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document_revision', 'publish',
          ${runtimeFixture.documentPublishOperationId}, ${timestamp}, ${timestamp})
    `
    yield* sql`
      INSERT INTO qrspi_implementation_step_operations (
        workflow_id, generation, stage_key, stage_revision, position,
        owner_kind, operation_role, operation_id, created_at, updated_at
      ) VALUES
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'produce', ${runtimeFixture.implementationProduceOperationId},
          ${timestamp}, ${timestamp}),
        (${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'publish', ${runtimeFixture.implementationPublishOperationId},
          ${timestamp}, ${timestamp})
    `
    yield* sql`
      UPDATE qrspi_stage_runs
      SET pending_revision = ${runtimeFixture.pendingRevision},
          published_revision = ${runtimeFixture.publishedRevision},
          accepted_revision = ${runtimeFixture.acceptedRevision}
      WHERE workflow_id = ${runtimeFixture.workflowId}
        AND generation = 1
        AND stage_key = ${runtimeFixture.documentStageKey}
        AND run_ordinal = ${runtimeFixture.currentRunOrdinal}
    `
    yield* sql`
      UPDATE qrspi_generations
      SET current_stage_key = ${runtimeFixture.documentStageKey},
          current_stage_run_ordinal = ${runtimeFixture.currentRunOrdinal}
      WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
    `
  })

  const expectIdentitySpineRejection = <A, E, R>(statement: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const before = yield* readRuntimeGraph
      expect(yield* rejected(statement)).toBe(true)
      const after = yield* readRuntimeGraph
      const foreignKeys = yield* sql`PRAGMA foreign_keys`
      const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`

      expect(after).toEqual(before)
      expect(foreignKeys).toEqual([{ foreign_keys: 1 }])
      expect(foreignKeyViolations).toEqual([])
    })

  test("seeds the complete valid tagged runtime graph", async () => {
    const result = await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedValidRuntimeIdentitySpine
        const graph = yield* readRuntimeGraph
        return {
          counts: Object.fromEntries(
            Object.entries(graph).map(([table, rows]) => [table, rows.length]),
          ),
          foreignKeys: yield* sql`PRAGMA foreign_keys`,
          foreignKeyViolations: yield* sql`PRAGMA foreign_key_check`,
        }
      }),
    )

    expect(result.counts).toEqual({
      qrspi_workflows: 1,
      qrspi_ticket_revisions: 1,
      qrspi_workflow_definitions: 1,
      qrspi_stage_definitions: 2,
      qrspi_generations: 2,
      workflow_operations: 4,
      qrspi_stage_runs: 4,
      qrspi_stage_revisions: 5,
      qrspi_document_stage_revisions: 4,
      qrspi_implementation_stage_revisions: 1,
      qrspi_implementation_steps: 1,
      qrspi_artifact_references: 1,
      qrspi_implementation_commit_references: 1,
      qrspi_implementation_checkpoints: 1,
      qrspi_stage_revision_diagnostics: 1,
      qrspi_stage_operation_owners: 4,
      qrspi_document_stage_revision_operations: 2,
      qrspi_implementation_step_operations: 2,
    })
    expect(result.foreignKeys).toEqual([{ foreign_keys: 1 }])
    expect(result.foreignKeyViolations).toEqual([])
  })

  const diagnosticParentIdentityCases = [
    {
      name: "rejects a diagnostic with the wrong workflow",
      assignment: "workflow_id",
      value: "workflow-runtime-identity-absent",
    },
    {
      name: "rejects a diagnostic with the wrong Generation",
      assignment: "generation",
      value: 2,
    },
    {
      name: "rejects a diagnostic with the wrong stage",
      assignment: "stage_key",
      value: "stage-runtime-identity-absent",
    },
    {
      name: "rejects a diagnostic with the wrong revision",
      assignment: "stage_revision",
      value: 5,
    },
  ].map((testCase) => ({
    name: testCase.name,
    statement: (sql: SqlClient.SqlClient) =>
      sql.unsafe(
        `UPDATE qrspi_stage_revision_diagnostics
         SET ${testCase.assignment} = ?
         WHERE workflow_id = ? AND generation = ?
           AND stage_key = ? AND stage_revision = ?`,
        [
          testCase.value,
          runtimeFixture.workflowId,
          1,
          runtimeFixture.documentStageKey,
          runtimeFixture.historicalRevision,
        ],
      ),
  }))

  const diagnosticLiteralAndBoundCases = [
    {
      name: "rejects an unsupported diagnostic reason",
      assignment: "reason",
      value: "future_reason",
    },
    { name: "rejects an empty diagnostic message", assignment: "message", value: "" },
    {
      name: "rejects an over-bound diagnostic message",
      assignment: "message",
      value: "m".repeat(2_001),
    },
    {
      name: "rejects an empty diagnostic observed kind",
      assignment: "observed_kind",
      value: "",
    },
    {
      name: "rejects an over-bound diagnostic observed kind",
      assignment: "observed_kind",
      value: "k".repeat(65),
    },
    {
      name: "rejects an empty diagnostic observed state",
      assignment: "observed_state",
      value: "",
    },
    {
      name: "rejects an over-bound diagnostic observed state",
      assignment: "observed_state",
      value: "s".repeat(65),
    },
  ].map((testCase) => ({
    name: testCase.name,
    statement: (sql: SqlClient.SqlClient) =>
      sql.unsafe(
        `UPDATE qrspi_stage_revision_diagnostics
         SET ${testCase.assignment} = ?
         WHERE workflow_id = ? AND generation = ?
           AND stage_key = ? AND stage_revision = ?`,
        [
          testCase.value,
          runtimeFixture.workflowId,
          1,
          runtimeFixture.documentStageKey,
          runtimeFixture.historicalRevision,
        ],
      ),
  }))

  const toDiagnosticFieldUpdate = (testCase: {
    readonly name: string
    readonly assignment: string
    readonly value: string
  }) => ({
    name: testCase.name,
    statement: (sql: SqlClient.SqlClient) =>
      sql.unsafe(
        `UPDATE qrspi_stage_revision_diagnostics
         SET ${testCase.assignment} = ?
         WHERE workflow_id = ? AND generation = ?
           AND stage_key = ? AND stage_revision = ?`,
        [
          testCase.value,
          runtimeFixture.workflowId,
          1,
          runtimeFixture.documentStageKey,
          runtimeFixture.historicalRevision,
        ],
      ),
  })

  const diagnosticJsonCases = [
    {
      name: "rejects malformed diagnostic expected JSON",
      assignment: "expected_json",
      value: "{not-json",
    },
    {
      name: "rejects array-root diagnostic expected JSON",
      assignment: "expected_json",
      value: "[]",
    },
    {
      name: "rejects malformed diagnostic actual JSON",
      assignment: "actual_json",
      value: "{not-json",
    },
    {
      name: "rejects array-root diagnostic actual JSON",
      assignment: "actual_json",
      value: "[]",
    },
  ].map(toDiagnosticFieldUpdate)

  const diagnosticHashCases = [
    {
      name: "rejects a wrong-length diagnostic expected SHA-256",
      assignment: "expected_sha256",
      value: "1".repeat(63),
    },
    {
      name: "rejects an uppercase diagnostic expected SHA-256",
      assignment: "expected_sha256",
      value: "A".repeat(64),
    },
    {
      name: "rejects a non-hex diagnostic expected SHA-256",
      assignment: "expected_sha256",
      value: `${"1".repeat(63)}g`,
    },
    {
      name: "rejects a wrong-length diagnostic actual SHA-256",
      assignment: "actual_sha256",
      value: "1".repeat(63),
    },
    {
      name: "rejects an uppercase diagnostic actual SHA-256",
      assignment: "actual_sha256",
      value: "A".repeat(64),
    },
    {
      name: "rejects a non-hex diagnostic actual SHA-256",
      assignment: "actual_sha256",
      value: `${"1".repeat(63)}g`,
    },
  ].map(toDiagnosticFieldUpdate)

  const diagnosticOneSidedPairCases = [
    {
      name: "rejects diagnostic expected JSON without its hash",
      assignment: "expected_sha256",
    },
    {
      name: "rejects diagnostic expected hash without its JSON",
      assignment: "expected_json",
    },
    {
      name: "rejects diagnostic actual JSON without its hash",
      assignment: "actual_sha256",
    },
    {
      name: "rejects diagnostic actual hash without its JSON",
      assignment: "actual_json",
    },
  ].map((testCase) => ({
    name: testCase.name,
    statement: (sql: SqlClient.SqlClient) =>
      sql.unsafe(
        `UPDATE qrspi_stage_revision_diagnostics
         SET ${testCase.assignment} = NULL
         WHERE workflow_id = ? AND generation = ?
           AND stage_key = ? AND stage_revision = ?`,
        [
          runtimeFixture.workflowId,
          1,
          runtimeFixture.documentStageKey,
          runtimeFixture.historicalRevision,
        ],
      ),
  }))

  const diagnosticRejectionCases = [
    ...diagnosticParentIdentityCases,
    ...diagnosticLiteralAndBoundCases,
    ...diagnosticJsonCases,
    ...diagnosticHashCases,
    ...diagnosticOneSidedPairCases,
  ]

  for (const testCase of diagnosticRejectionCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  const diagnosticPairAbsenceCases = [
    {
      name: "allows an absent expected pair with a complete actual pair",
      assignment: "expected_json = NULL, expected_sha256 = NULL",
      expected: {
        expected_json: null,
        actual_json: '{"kind":"implementation"}',
        expected_sha256: null,
        actual_sha256: "9".repeat(64),
      },
    },
    {
      name: "allows an absent actual pair with a complete expected pair",
      assignment: "actual_json = NULL, actual_sha256 = NULL",
      expected: {
        expected_json: '{"kind":"document"}',
        actual_json: null,
        expected_sha256: "8".repeat(64),
        actual_sha256: null,
      },
    },
  ] as const

  for (const testCase of diagnosticPairAbsenceCases) {
    test(testCase.name, async () => {
      const result = await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          yield* sql.unsafe(
            `UPDATE qrspi_stage_revision_diagnostics
             SET ${testCase.assignment}
             WHERE workflow_id = ? AND generation = ?
               AND stage_key = ? AND stage_revision = ?`,
            [
              runtimeFixture.workflowId,
              1,
              runtimeFixture.documentStageKey,
              runtimeFixture.historicalRevision,
            ],
          )
          return {
            diagnostic: yield* sql`
              SELECT expected_json, actual_json, expected_sha256, actual_sha256
              FROM qrspi_stage_revision_diagnostics
              WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
                AND stage_key = ${runtimeFixture.documentStageKey}
                AND stage_revision = ${runtimeFixture.historicalRevision}
            `,
            foreignKeys: yield* sql`PRAGMA foreign_keys`,
            foreignKeyViolations: yield* sql`PRAGMA foreign_key_check`,
          }
        }),
      )

      expect(result.diagnostic).toEqual([testCase.expected])
      expect(result.foreignKeys).toEqual([{ foreign_keys: 1 }])
      expect(result.foreignKeyViolations).toEqual([])
    })
  }

  test("reconciles diagnostic pair completeness with the allocated parent coverage", () => {
    expect({
      parentIdentity: diagnosticParentIdentityCases.length,
      literalAndBound: diagnosticLiteralAndBoundCases.length,
      json: diagnosticJsonCases.length,
      hash: diagnosticHashCases.length,
      oneSidedPair: diagnosticOneSidedPairCases.length,
      rejectionTotal: diagnosticRejectionCases.length,
      positiveAbsence: diagnosticPairAbsenceCases.length,
      allocatedParentAcceptance: [
        "criterion 3",
        "criterion 4",
        "criterion 5 diagnostic portion",
        "criterion 6 diagnostic portion",
      ],
    }).toEqual({
      parentIdentity: 4,
      literalAndBound: 7,
      json: 4,
      hash: 6,
      oneSidedPair: 4,
      rejectionTotal: 25,
      positiveAbsence: 2,
      allocatedParentAcceptance: [
        "criterion 3",
        "criterion 4",
        "criterion 5 diagnostic portion",
        "criterion 6 diagnostic portion",
      ],
    })
  })

  const taggedVariantCases = [
    {
      name: "rejects document payload kind implementation",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions SET kind = 'implementation'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects implementation payload kind document",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions SET kind = 'document'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
    {
      name: "rejects a document payload attached to an implementation StageRevision",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_result_json, prepared_result_sha256, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          'document', ${runtimeFixture.documentPreparedResultJson},
          ${runtimeFixture.documentPreparedResultSha256},
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation payload attached to a document StageRevision",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_delivery_evidence_json, prepared_delivery_evidence_sha256,
          created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'implementation',
          ${runtimeFixture.implementationEvidenceJson},
          ${runtimeFixture.implementationEvidenceSha256},
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation step attached to a document payload identity",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_steps (
          workflow_id, generation, stage_key, stage_revision, position,
          prepared_result_json, prepared_result_sha256, final, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 2,
          ${runtimeFixture.stepPreparedResultJson},
          ${runtimeFixture.stepPreparedResultSha256}, 1, ${timestamp}, ${timestamp}
        )
      `,
    },
  ] as const

  for (const testCase of taggedVariantCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  const taggedParentIdentityCases = [
    {
      name: "rejects a document payload with the wrong workflow",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_result_json, prepared_result_sha256, created_at, updated_at
        ) VALUES (
          'workflow-runtime-identity-absent', 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document',
          ${runtimeFixture.documentPreparedResultJson},
          ${runtimeFixture.documentPreparedResultSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a document payload with the wrong Generation",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_result_json, prepared_result_sha256, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 2, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document',
          ${runtimeFixture.documentPreparedResultJson},
          ${runtimeFixture.documentPreparedResultSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a document payload with the wrong stage",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_result_json, prepared_result_sha256, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey},
          ${runtimeFixture.acceptedRevision}, 'document',
          ${runtimeFixture.documentPreparedResultJson},
          ${runtimeFixture.documentPreparedResultSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a document payload with the wrong revision",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_result_json, prepared_result_sha256, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 5,
          'document', ${runtimeFixture.documentPreparedResultJson},
          ${runtimeFixture.documentPreparedResultSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation payload with the wrong workflow",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_delivery_evidence_json, prepared_delivery_evidence_sha256,
          created_at, updated_at
        ) VALUES (
          'workflow-runtime-identity-absent', 1,
          ${runtimeFixture.implementationStageKey}, 1, 'implementation',
          ${runtimeFixture.implementationEvidenceJson},
          ${runtimeFixture.implementationEvidenceSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation payload with the wrong Generation",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_delivery_evidence_json, prepared_delivery_evidence_sha256,
          created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 2, ${runtimeFixture.implementationStageKey}, 1,
          'implementation', ${runtimeFixture.implementationEvidenceJson},
          ${runtimeFixture.implementationEvidenceSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation payload with the wrong stage",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_delivery_evidence_json, prepared_delivery_evidence_sha256,
          created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 1,
          'implementation', ${runtimeFixture.implementationEvidenceJson},
          ${runtimeFixture.implementationEvidenceSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation payload with the wrong revision",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, kind,
          prepared_delivery_evidence_json, prepared_delivery_evidence_sha256,
          created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 5,
          'implementation', ${runtimeFixture.implementationEvidenceJson},
          ${runtimeFixture.implementationEvidenceSha256}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation step with the wrong workflow",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_steps (
          workflow_id, generation, stage_key, stage_revision, position,
          prepared_result_json, prepared_result_sha256, final, created_at, updated_at
        ) VALUES (
          'workflow-runtime-identity-absent', 1,
          ${runtimeFixture.implementationStageKey}, 1, 2,
          ${runtimeFixture.stepPreparedResultJson},
          ${runtimeFixture.stepPreparedResultSha256}, 1, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation step with the wrong Generation",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_steps (
          workflow_id, generation, stage_key, stage_revision, position,
          prepared_result_json, prepared_result_sha256, final, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 2, ${runtimeFixture.implementationStageKey}, 1, 2,
          ${runtimeFixture.stepPreparedResultJson},
          ${runtimeFixture.stepPreparedResultSha256}, 1, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation step with the wrong stage",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_steps (
          workflow_id, generation, stage_key, stage_revision, position,
          prepared_result_json, prepared_result_sha256, final, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 1, 2,
          ${runtimeFixture.stepPreparedResultJson},
          ${runtimeFixture.stepPreparedResultSha256}, 1, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation step with the wrong revision",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_steps (
          workflow_id, generation, stage_key, stage_revision, position,
          prepared_result_json, prepared_result_sha256, final, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 5, 2,
          ${runtimeFixture.stepPreparedResultJson},
          ${runtimeFixture.stepPreparedResultSha256}, 1, ${timestamp}, ${timestamp}
        )
      `,
    },
  ] as const

  for (const testCase of taggedParentIdentityCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  const sourceSetCases = [
    {
      name: "rejects malformed StageRevision source_set_json",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_revisions SET source_set_json = '{not-json'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects object-root StageRevision source_set_json",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_revisions SET source_set_json = '{}'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects a wrong-length StageRevision source_set_sha256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_revisions SET source_set_sha256 = ${"1".repeat(63)}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects an uppercase StageRevision source_set_sha256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_revisions SET source_set_sha256 = ${"A".repeat(64)}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects a non-hex StageRevision source_set_sha256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_revisions SET source_set_sha256 = ${`${"1".repeat(63)}g`}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
  ] as const

  const documentPayloadCases = [
    {
      name: "rejects malformed document prepared-result JSON",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions SET prepared_result_json = '{not-json'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects array-root document prepared-result JSON",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions SET prepared_result_json = '[]'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects a wrong-length document prepared-result SHA-256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions
        SET prepared_result_sha256 = ${"1".repeat(63)}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects an uppercase document prepared-result SHA-256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions
        SET prepared_result_sha256 = ${"A".repeat(64)}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects a non-hex document prepared-result SHA-256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions
        SET prepared_result_sha256 = ${`${"1".repeat(63)}g`}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects document prepared-result JSON without its hash",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions SET prepared_result_sha256 = NULL
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    {
      name: "rejects document prepared-result hash without its JSON",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revisions SET prepared_result_json = NULL
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
  ] as const

  const implementationPayloadCases = [
    {
      name: "rejects malformed implementation delivery-evidence JSON",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions
        SET prepared_delivery_evidence_json = '{not-json'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
    {
      name: "rejects array-root implementation delivery-evidence JSON",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions
        SET prepared_delivery_evidence_json = '[]'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
    {
      name: "rejects a wrong-length implementation delivery-evidence SHA-256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions
        SET prepared_delivery_evidence_sha256 = ${"1".repeat(63)}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
    {
      name: "rejects an uppercase implementation delivery-evidence SHA-256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions
        SET prepared_delivery_evidence_sha256 = ${"A".repeat(64)}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
    {
      name: "rejects a non-hex implementation delivery-evidence SHA-256",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions
        SET prepared_delivery_evidence_sha256 = ${`${"1".repeat(63)}g`}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
    {
      name: "rejects implementation delivery-evidence JSON without its hash",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions
        SET prepared_delivery_evidence_sha256 = NULL
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
    {
      name: "rejects implementation delivery-evidence hash without its JSON",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_stage_revisions
        SET prepared_delivery_evidence_json = NULL
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.implementationStageKey}
          AND stage_revision = 1
      `,
    },
  ] as const

  const incompleteStepTriads = [
    {
      name: "rejects a step with only prepared-result JSON",
      preparedResultJson: runtimeFixture.stepPreparedResultJson,
      preparedResultSha256: null,
      final: null,
    },
    {
      name: "rejects a step with only prepared-result hash",
      preparedResultJson: null,
      preparedResultSha256: runtimeFixture.stepPreparedResultSha256,
      final: null,
    },
    {
      name: "rejects a step with only final",
      preparedResultJson: null,
      preparedResultSha256: null,
      final: 1,
    },
    {
      name: "rejects a step with prepared-result JSON and hash but no final",
      preparedResultJson: runtimeFixture.stepPreparedResultJson,
      preparedResultSha256: runtimeFixture.stepPreparedResultSha256,
      final: null,
    },
    {
      name: "rejects a step with prepared-result JSON and final but no hash",
      preparedResultJson: runtimeFixture.stepPreparedResultJson,
      preparedResultSha256: null,
      final: 1,
    },
    {
      name: "rejects a step with prepared-result hash and final but no JSON",
      preparedResultJson: null,
      preparedResultSha256: runtimeFixture.stepPreparedResultSha256,
      final: 1,
    },
  ] as const

  const stepTriadCases = incompleteStepTriads.map((testCase) => ({
    name: testCase.name,
    statement: (sql: SqlClient.SqlClient) => sql`
      UPDATE qrspi_implementation_steps
      SET prepared_result_json = ${testCase.preparedResultJson},
          prepared_result_sha256 = ${testCase.preparedResultSha256},
          final = ${testCase.final}
      WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
        AND stage_key = ${runtimeFixture.implementationStageKey}
        AND stage_revision = 1
        AND position = ${runtimeFixture.implementationStepPosition}
    `,
  }))

  const stepValueCases = [
    {
      name: "rejects malformed implementation-step prepared-result JSON",
      assignment: "prepared_result_json",
      value: "{not-json",
    },
    {
      name: "rejects array-root implementation-step prepared-result JSON",
      assignment: "prepared_result_json",
      value: "[]",
    },
    {
      name: "rejects a wrong-length implementation-step prepared-result SHA-256",
      assignment: "prepared_result_sha256",
      value: "1".repeat(63),
    },
    {
      name: "rejects an uppercase implementation-step prepared-result SHA-256",
      assignment: "prepared_result_sha256",
      value: "A".repeat(64),
    },
    {
      name: "rejects a non-hex implementation-step prepared-result SHA-256",
      assignment: "prepared_result_sha256",
      value: `${"1".repeat(63)}g`,
    },
    {
      name: "rejects implementation-step final -1",
      assignment: "final",
      value: -1,
    },
    {
      name: "rejects implementation-step final 2",
      assignment: "final",
      value: 2,
    },
  ].map((testCase) => ({
    name: testCase.name,
    statement: (sql: SqlClient.SqlClient) =>
      sql.unsafe(
        `UPDATE qrspi_implementation_steps
         SET ${testCase.assignment} = ?
         WHERE workflow_id = ? AND generation = ? AND stage_key = ?
           AND stage_revision = ? AND position = ?`,
        [
          testCase.value,
          runtimeFixture.workflowId,
          1,
          runtimeFixture.implementationStageKey,
          1,
          runtimeFixture.implementationStepPosition,
        ],
      ),
  }))

  const stepPositionCases = ([0, 1_000_001] as const).map((position) => ({
    name: `rejects implementation-step position ${position}`,
    statement: (sql: SqlClient.SqlClient) => sql`
      INSERT INTO qrspi_implementation_steps (
        workflow_id, generation, stage_key, stage_revision, position,
        prepared_result_json, prepared_result_sha256, final, created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
        ${position}, ${runtimeFixture.stepPreparedResultJson},
        ${runtimeFixture.stepPreparedResultSha256}, 1, ${timestamp}, ${timestamp}
      )
    `,
  }))

  const taggedPayloadCases = [
    ...sourceSetCases,
    ...documentPayloadCases,
    ...implementationPayloadCases,
    ...stepTriadCases,
    ...stepValueCases,
    ...stepPositionCases,
  ]

  for (const testCase of taggedPayloadCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  const commonOperationOwnerCases = [
    {
      name: "rejects a common owner with an unsupported operation kind",
      operationId: "runtime-owner-unsupported-kind",
      physicalKind: "ReviewContribute",
      setup: insertRuntimeOperation("runtime-owner-unsupported-kind", "ReviewContribute"),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          'runtime-owner-unsupported-kind', 'ReviewContribute',
          'document_revision', 'produce', ${timestamp}
        )
      `,
    },
    {
      name: "rejects a common owner with an unsupported owner kind",
      operationId: "runtime-owner-unsupported-owner",
      physicalKind: "StageProduce",
      setup: insertRuntimeOperation("runtime-owner-unsupported-owner", "StageProduce"),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          'runtime-owner-unsupported-owner', 'StageProduce',
          'stage_run', 'produce', ${timestamp}
        )
      `,
    },
    {
      name: "rejects a common owner with an unsupported operation role",
      operationId: "runtime-owner-unsupported-role",
      physicalKind: "StageProduce",
      setup: insertRuntimeOperation("runtime-owner-unsupported-role", "StageProduce"),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          'runtime-owner-unsupported-role', 'StageProduce',
          'document_revision', 'review', ${timestamp}
        )
      `,
    },
    {
      name: "rejects a common owner with produce paired to the publish kind",
      operationId: "runtime-owner-produce-publish-kind",
      physicalKind: "ArtifactPublish",
      setup: insertRuntimeOperation("runtime-owner-produce-publish-kind", "ArtifactPublish"),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          'runtime-owner-produce-publish-kind', 'ArtifactPublish',
          'document_revision', 'produce', ${timestamp}
        )
      `,
    },
    {
      name: "rejects a common owner with publish paired to the produce kind",
      operationId: "runtime-owner-publish-produce-kind",
      physicalKind: "StageProduce",
      setup: insertRuntimeOperation("runtime-owner-publish-produce-kind", "StageProduce"),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          'runtime-owner-publish-produce-kind', 'StageProduce',
          'document_revision', 'publish', ${timestamp}
        )
      `,
    },
    {
      name: "rejects a common owner whose declared kind differs from its physical operation",
      operationId: "runtime-owner-physical-kind",
      physicalKind: "ArtifactPublish",
      setup: insertRuntimeOperation("runtime-owner-physical-kind", "ArtifactPublish"),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          'runtime-owner-physical-kind', 'StageProduce',
          'document_revision', 'produce', ${timestamp}
        )
      `,
    },
    {
      name: "rejects a common owner for a missing physical operation",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_operation_owners (
          operation_id, operation_kind, owner_kind, operation_role, created_at
        ) VALUES (
          'runtime-owner-missing-operation', 'StageProduce',
          'document_revision', 'produce', ${timestamp}
        )
      `,
    },
  ] as const

  for (const testCase of commonOperationOwnerCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          if ("setup" in testCase) {
            yield* testCase.setup
            expect(
              yield* sql`
                SELECT kind FROM workflow_operations
                WHERE operation_id = ${testCase.operationId}
              `,
            ).toEqual([{ kind: testCase.physicalKind }])
          }
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  const documentOperationOwnerCases = [
    {
      name: "rejects a document operation with the implementation owner tag",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_document_stage_revision_operations
        SET owner_kind = 'implementation_step'
        WHERE operation_id = ${runtimeFixture.documentProduceOperationId}
      `,
    },
    {
      name: "rejects a document operation with the wrong workflow parent",
      setup: insertRuntimeOperationOwner(
        "runtime-document-owner-wrong-workflow",
        "StageProduce",
        "document_revision",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          'workflow-runtime-identity-absent', 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document_revision', 'produce',
          'runtime-document-owner-wrong-workflow', ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a document operation with the wrong Generation parent",
      setup: insertRuntimeOperationOwner(
        "runtime-document-owner-wrong-generation",
        "StageProduce",
        "document_revision",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 2, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document_revision', 'produce',
          'runtime-document-owner-wrong-generation', ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a document operation with the wrong stage parent",
      setup: insertRuntimeOperationOwner(
        "runtime-document-owner-wrong-stage",
        "StageProduce",
        "document_revision",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey},
          ${runtimeFixture.acceptedRevision}, 'document_revision', 'produce',
          'runtime-document-owner-wrong-stage', ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a document operation with the wrong revision parent",
      setup: insertRuntimeOperationOwner(
        "runtime-document-owner-wrong-revision",
        "StageProduce",
        "document_revision",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 5,
          'document_revision', 'produce', 'runtime-document-owner-wrong-revision',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    ...([0, 1_000_001] as const).map((stageRevision) => {
      const operationId = `runtime-document-owner-revision-${stageRevision}`
      return {
        name: `rejects a document operation with revision ${stageRevision}`,
        setup: insertRuntimeOperationOwner(
          operationId,
          "StageProduce",
          "document_revision",
          "produce",
        ),
        statement: (sql: SqlClient.SqlClient) => sql`
          INSERT INTO qrspi_document_stage_revision_operations (
            workflow_id, generation, stage_key, stage_revision,
            owner_kind, operation_role, operation_id, created_at, updated_at
          ) VALUES (
            ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
            ${stageRevision}, 'document_revision', 'produce', ${operationId},
            ${timestamp}, ${timestamp}
          )
        `,
      }
    }),
    {
      name: "rejects a document operation whose common owner is an implementation step",
      setup: insertRuntimeOperationOwner(
        "runtime-document-owner-common-implementation",
        "StageProduce",
        "implementation_step",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.pendingRevision}, 'document_revision', 'produce',
          'runtime-document-owner-common-implementation', ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a document produce operation whose common role is publish",
      setup: insertRuntimeOperationOwner(
        "runtime-document-owner-common-publish",
        "ArtifactPublish",
        "document_revision",
        "publish",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.pendingRevision}, 'document_revision', 'produce',
          'runtime-document-owner-common-publish', ${timestamp}, ${timestamp}
        )
      `,
    },
  ]

  const implementationStepOperationOwnerCases = [
    {
      name: "rejects an implementation operation with the document owner tag",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_implementation_step_operations
        SET owner_kind = 'document_revision'
        WHERE operation_id = ${runtimeFixture.implementationProduceOperationId}
      `,
    },
    {
      name: "rejects an implementation operation with the wrong workflow parent",
      setup: insertRuntimeOperationOwner(
        "runtime-implementation-owner-wrong-workflow",
        "StageProduce",
        "implementation_step",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          'workflow-runtime-identity-absent', 1,
          ${runtimeFixture.implementationStageKey}, 1,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'produce', 'runtime-implementation-owner-wrong-workflow',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation operation with the wrong Generation parent",
      setup: insertRuntimeOperationOwner(
        "runtime-implementation-owner-wrong-generation",
        "StageProduce",
        "implementation_step",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 2, ${runtimeFixture.implementationStageKey}, 1,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'produce', 'runtime-implementation-owner-wrong-generation',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation operation with the wrong stage parent",
      setup: insertRuntimeOperationOwner(
        "runtime-implementation-owner-wrong-stage",
        "StageProduce",
        "implementation_step",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 1,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'produce', 'runtime-implementation-owner-wrong-stage',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation operation with the wrong revision parent",
      setup: insertRuntimeOperationOwner(
        "runtime-implementation-owner-wrong-revision",
        "StageProduce",
        "implementation_step",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 5,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'produce', 'runtime-implementation-owner-wrong-revision',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation operation with the wrong step parent",
      setup: insertRuntimeOperationOwner(
        "runtime-implementation-owner-wrong-step",
        "StageProduce",
        "implementation_step",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1, 2,
          'implementation_step', 'produce',
          'runtime-implementation-owner-wrong-step', ${timestamp}, ${timestamp}
        )
      `,
    },
    ...([0, 1_000_001] as const).map((stageRevision) => {
      const operationId = `runtime-implementation-owner-revision-${stageRevision}`
      return {
        name: `rejects an implementation operation with revision ${stageRevision}`,
        setup: insertRuntimeOperationOwner(
          operationId,
          "StageProduce",
          "implementation_step",
          "produce",
        ),
        statement: (sql: SqlClient.SqlClient) => sql`
          INSERT INTO qrspi_implementation_step_operations (
            workflow_id, generation, stage_key, stage_revision, position,
            owner_kind, operation_role, operation_id, created_at, updated_at
          ) VALUES (
            ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey},
            ${stageRevision}, ${runtimeFixture.implementationStepPosition},
            'implementation_step', 'produce', ${operationId}, ${timestamp}, ${timestamp}
          )
        `,
      }
    }),
    ...([0, 1_000_001] as const).map((position) => {
      const operationId = `runtime-implementation-owner-position-${position}`
      return {
        name: `rejects an implementation operation with position ${position}`,
        setup: insertRuntimeOperationOwner(
          operationId,
          "StageProduce",
          "implementation_step",
          "produce",
        ),
        statement: (sql: SqlClient.SqlClient) => sql`
          INSERT INTO qrspi_implementation_step_operations (
            workflow_id, generation, stage_key, stage_revision, position,
            owner_kind, operation_role, operation_id, created_at, updated_at
          ) VALUES (
            ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
            ${position}, 'implementation_step', 'produce', ${operationId},
            ${timestamp}, ${timestamp}
          )
        `,
      }
    }),
    {
      name: "rejects an implementation operation whose common owner is a document revision",
      setup: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* insertRuntimeOperationOwner(
          "runtime-implementation-owner-common-document",
          "StageProduce",
          "document_revision",
          "produce",
        )
        yield* sql`
          INSERT INTO qrspi_implementation_steps (
            workflow_id, generation, stage_key, stage_revision, position,
            prepared_result_json, prepared_result_sha256, final, created_at, updated_at
          ) VALUES (
            ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
            2, NULL, NULL, NULL, ${timestamp}, ${timestamp}
          )
        `
      }),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          2, 'implementation_step',
          'produce', 'runtime-implementation-owner-common-document',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an implementation produce operation whose common role is publish",
      setup: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* insertRuntimeOperationOwner(
          "runtime-implementation-owner-common-publish",
          "ArtifactPublish",
          "implementation_step",
          "publish",
        )
        yield* sql`
          INSERT INTO qrspi_implementation_steps (
            workflow_id, generation, stage_key, stage_revision, position,
            prepared_result_json, prepared_result_sha256, final, created_at, updated_at
          ) VALUES (
            ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
            2, NULL, NULL, NULL, ${timestamp}, ${timestamp}
          )
        `
      }),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          2, 'implementation_step',
          'produce', 'runtime-implementation-owner-common-publish',
          ${timestamp}, ${timestamp}
        )
      `,
    },
  ]

  const taggedOperationOwnerCases = [
    ...documentOperationOwnerCases,
    ...implementationStepOperationOwnerCases,
  ]

  for (const testCase of taggedOperationOwnerCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          if ("setup" in testCase) yield* testCase.setup
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  const operationOwnershipReuseCases = [
    {
      name: "rejects a second produce operation for one document revision",
      setup: insertRuntimeOperationOwner(
        "runtime-document-duplicate-produce",
        "StageProduce",
        "document_revision",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document_revision', 'produce',
          'runtime-document-duplicate-produce', ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a second publish operation for one document revision",
      setup: insertRuntimeOperationOwner(
        "runtime-document-duplicate-publish",
        "ArtifactPublish",
        "document_revision",
        "publish",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.acceptedRevision}, 'document_revision', 'publish',
          'runtime-document-duplicate-publish', ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a second produce operation for one implementation step",
      setup: insertRuntimeOperationOwner(
        "runtime-implementation-duplicate-produce",
        "StageProduce",
        "implementation_step",
        "produce",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'produce', 'runtime-implementation-duplicate-produce',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a second publish operation for one implementation step",
      setup: insertRuntimeOperationOwner(
        "runtime-implementation-duplicate-publish",
        "ArtifactPublish",
        "implementation_step",
        "publish",
      ),
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          ${runtimeFixture.implementationStepPosition}, 'implementation_step',
          'publish', 'runtime-implementation-duplicate-publish',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects reusing one physical operation for two document revisions",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.pendingRevision}, 'document_revision', 'produce',
          ${runtimeFixture.documentProduceOperationId}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects reusing one physical operation for two implementation steps",
      setup: insertSecondImplementationStep,
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          2, 'implementation_step', 'produce',
          ${runtimeFixture.implementationProduceOperationId}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects reusing a document operation for an implementation step",
      setup: insertSecondImplementationStep,
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_implementation_step_operations (
          workflow_id, generation, stage_key, stage_revision, position,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
          2, 'implementation_step', 'produce',
          ${runtimeFixture.documentProduceOperationId}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects reusing an implementation operation for a document revision",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_document_stage_revision_operations (
          workflow_id, generation, stage_key, stage_revision,
          owner_kind, operation_role, operation_id, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runtimeFixture.pendingRevision}, 'document_revision', 'produce',
          ${runtimeFixture.implementationProduceOperationId}, ${timestamp}, ${timestamp}
        )
      `,
    },
  ]

  for (const testCase of operationOwnershipReuseCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          if ("setup" in testCase) yield* testCase.setup
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  test("reconciles the complete operation-ownership rejection matrix", () => {
    expect({
      common: commonOperationOwnerCases.length,
      document: documentOperationOwnerCases.length,
      implementation: implementationStepOperationOwnerCases.length,
      reuse: operationOwnershipReuseCases.length,
      total:
        commonOperationOwnerCases.length +
        documentOperationOwnerCases.length +
        implementationStepOperationOwnerCases.length +
        operationOwnershipReuseCases.length,
    }).toEqual({ common: 7, document: 9, implementation: 12, reuse: 8, total: 36 })
  })

  const localIdentityCases = [
    {
      name: "rejects an unsupported Generation format",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_generations SET generation_format = 'future_runtime_v2'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
      `,
    },
    {
      name: "rejects an unsupported StageRun state",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_runs SET state = 'future_state'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND run_ordinal = ${runtimeFixture.historicalRunOrdinal}
      `,
    },
    ...([-1, 2] as const).map((isCurrent) => ({
      name: `rejects StageRun is_current ${isCurrent}`,
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_runs SET is_current = ${isCurrent}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND run_ordinal = ${runtimeFixture.historicalRunOrdinal}
      `,
    })),
    {
      name: "rejects an unsupported StageRevision kind",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, run_ordinal, kind,
          state, owner_crossing_key, source_set_json, source_set_sha256,
          created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 5,
          ${runtimeFixture.currentRunOrdinal}, 'future_kind', 'producing',
          'owner-invalid-kind', '[]', ${"1".repeat(64)}, ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects an unsupported StageRevision state",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_revisions SET state = 'future_state'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.historicalRevision}
      `,
    },
    ...([0, 1_000_001] as const).map((runOrdinal) => ({
      name: `rejects StageRun run_ordinal ${runOrdinal}`,
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_runs (
          workflow_id, generation, stage_key, run_ordinal,
          workflow_definition_sha256, stage_definition_sha256, state, is_current,
          activation_policy_json, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${runOrdinal}, ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.documentStageDefinitionSha256}, 'blocked', 0, '{}',
          ${timestamp}, ${timestamp}
        )
      `,
    })),
    ...([0, 1_000_001] as const).map((runOrdinal) => ({
      name: `rejects StageRevision run_ordinal ${runOrdinal}`,
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, run_ordinal, kind,
          state, owner_crossing_key, source_set_json, source_set_sha256,
          created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 5,
          ${runOrdinal}, 'document', 'producing',
          ${`owner-invalid-run-${runOrdinal}`}, '[]', ${"1".repeat(64)},
          ${timestamp}, ${timestamp}
        )
      `,
    })),
    ...([0, 1_000_001] as const).map((stageRevision) => ({
      name: `rejects StageRevision stage_revision ${stageRevision}`,
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_revisions (
          workflow_id, generation, stage_key, stage_revision, run_ordinal, kind,
          state, owner_crossing_key, source_set_json, source_set_sha256,
          created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey},
          ${stageRevision}, ${runtimeFixture.currentRunOrdinal}, 'document',
          'producing', ${`owner-invalid-revision-${stageRevision}`}, '[]',
          ${"1".repeat(64)}, ${timestamp}, ${timestamp}
        )
      `,
    })),
    ...([0, 1_000_001] as const).map((cursorOrdinal) => ({
      name: `rejects Generation current_stage_run_ordinal ${cursorOrdinal}`,
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_generations
        SET current_stage_run_ordinal = ${cursorOrdinal}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
      `,
    })),
    ...(["pending_revision", "published_revision", "accepted_revision"] as const).flatMap(
      (pointer) =>
        ([0, 1_000_001] as const).map((revision) => ({
          name: `rejects StageRun ${pointer} ${revision}`,
          statement: (sql: SqlClient.SqlClient) =>
            sql.unsafe(
              `UPDATE qrspi_stage_runs
               SET ${pointer} = ?
               WHERE workflow_id = ? AND generation = ?
                 AND stage_key = ? AND run_ordinal = ?`,
              [
                revision,
                runtimeFixture.workflowId,
                1,
                runtimeFixture.documentStageKey,
                runtimeFixture.currentRunOrdinal,
              ],
            ),
        })),
    ),
  ] as const

  for (const testCase of localIdentityCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

  const relationalIdentityCases = [
    {
      name: "rejects a Generation cursor with only a run ordinal",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_generations
        SET current_stage_key = NULL
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
      `,
    },
    {
      name: "rejects a Generation cursor with only a stage key",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_generations
        SET current_stage_run_ordinal = NULL
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
      `,
    },
    {
      name: "rejects a Generation cursor that resolves only in another Generation",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_generations
        SET current_stage_key = ${runtimeFixture.documentStageKey},
            current_stage_run_ordinal = ${runtimeFixture.otherGenerationRunOrdinal}
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
      `,
    },
    {
      name: "rejects a second current run for one Generation stage",
      statement: (sql: SqlClient.SqlClient) => sql`
        INSERT INTO qrspi_stage_runs (
          workflow_id, generation, stage_key, run_ordinal,
          workflow_definition_sha256, stage_definition_sha256, state, is_current,
          activation_policy_json, created_at, updated_at
        ) VALUES (
          ${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 5,
          ${runtimeFixture.workflowDefinitionSha256},
          ${runtimeFixture.documentStageDefinitionSha256}, 'blocked', 1, '{}',
          ${timestamp}, ${timestamp}
        )
      `,
    },
    {
      name: "rejects a duplicate owner-crossing key across runtime identities",
      statement: (sql: SqlClient.SqlClient) => sql`
        UPDATE qrspi_stage_revisions
        SET owner_crossing_key = 'owner-research-historical'
        WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
          AND stage_key = ${runtimeFixture.documentStageKey}
          AND stage_revision = ${runtimeFixture.acceptedRevision}
      `,
    },
    ...(["pending_revision", "published_revision", "accepted_revision"] as const).map(
      (pointer) => ({
        name: `rejects a ${pointer} pointer to another run`,
        statement: (sql: SqlClient.SqlClient) =>
          sql.unsafe(
            `UPDATE qrspi_stage_runs
             SET ${pointer} = ?
             WHERE workflow_id = ? AND generation = ?
               AND stage_key = ? AND run_ordinal = ?`,
            [
              runtimeFixture.historicalRevision,
              runtimeFixture.workflowId,
              1,
              runtimeFixture.documentStageKey,
              runtimeFixture.currentRunOrdinal,
            ],
          ),
      }),
    ),
  ] as const

  for (const testCase of relationalIdentityCases) {
    test(testCase.name, async () => {
      await runWithDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seedValidRuntimeIdentitySpine
          yield* expectIdentitySpineRejection(testCase.statement(sql))
        }),
      )
    })
  }

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

  type HistoricalGenerationRow = {
    readonly workflow_id: string
    readonly generation: number
    readonly repository_json: string
    readonly base_ref: string
    readonly base_sha: string
    readonly head_ref: string
    readonly root_sha: string
    readonly current_head_sha: string
    readonly ticket_revision_sha256: string
    readonly workflow_definition_sha256: string
    readonly state: string
    readonly is_current: number
    readonly created_at: string
    readonly updated_at: string
    readonly generation_format: "legacy" | "stage_snapshots_v1"
  }

  type UpgradedGenerationRow = HistoricalGenerationRow & {
    readonly current_stage_key: string | null
    readonly current_stage_run_ordinal: number | null
  }

  type MigrationRow = {
    readonly migration_id: number
    readonly name: string
  }

  test("preserves complete through-0010 history across a fresh file-backed layer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflowd-migration-"))
    const filename = join(directory, "workflowd.db")

    try {
      const historical = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const ticketRevision1 = "a".repeat(64)
          const ticketRevision2 = "b".repeat(64)
          const workflowDefinition1 = "c".repeat(64)
          const workflowDefinition2 = "d".repeat(64)
          yield* sql`PRAGMA foreign_keys = ON`
          yield* runStoreMigrationsThrough0010
          yield* sql`
            INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
            VALUES (
              'workflow-1', 'workflow-branch',
              '2026-07-19T09:00:00.000Z', '2026-07-19T12:00:00.000Z'
            )
          `
          yield* sql`
            INSERT INTO qrspi_ticket_revisions (
              workflow_id, ticket_revision_sha256, revision_json, checked_at
            ) VALUES
              (
                'workflow-1', ${ticketRevision1}, '{"ticket":"historical"}',
                '2026-07-19T09:30:00.000Z'
              ),
              (
                'workflow-1', ${ticketRevision2}, '{"ticket":"current","revision":2}',
                '2026-07-19T10:30:00.000Z'
              )
          `
          yield* sql`
            INSERT INTO qrspi_workflow_definitions (
              definition_sha256, definition_json, created_at
            ) VALUES
              (
                ${workflowDefinition1}, '{"workflow":"historical"}',
                '2026-07-19T09:40:00.000Z'
              ),
              (
                ${workflowDefinition2}, '{"workflow":"current","stages":[]}',
                '2026-07-19T10:40:00.000Z'
              )
          `
          yield* sql`
            INSERT INTO qrspi_generations (
              workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
              root_sha, current_head_sha, ticket_revision_sha256,
              workflow_definition_sha256, state, is_current, created_at, updated_at,
              generation_format
            ) VALUES
              (
                'workflow-1', 1, '{"repository":"historical"}', 'release/1',
                ${"1".repeat(40)}, 'workflow/release-1', ${"2".repeat(64)},
                ${"3".repeat(40)}, ${ticketRevision1}, ${workflowDefinition1},
                'completed', 0, '2026-07-19T10:00:00.000Z',
                '2026-07-19T10:30:00.000Z', 'legacy'
              ),
              (
                'workflow-1', 2, '{"repository":"current","renamed":true}', 'main',
                ${"4".repeat(64)}, 'workflow/current', ${"5".repeat(40)},
                ${"6".repeat(64)}, ${ticketRevision2}, ${workflowDefinition2},
                'waiting_human', 1, '2026-07-19T11:00:00.000Z',
                '2026-07-19T12:00:00.000Z', 'stage_snapshots_v1'
              )
          `
          yield* sql`
            INSERT INTO workflow_operations (
              operation_id, logical_operation_id, operation_revision, retry_of, kind,
              scope_json, input_json, input_sha256, output_json, state, is_current,
              attempt, max_attempts, lease_owner, lease_token, lease_until, run_at,
              external_intent_json, external_observation_json, observation_attempts,
              max_observation_attempts, parent_effect_json, last_error,
              terminal_failure_reason, terminal_retry_policy, created_at, updated_at
            ) VALUES
              (
                'produce-1-r1', 'produce-1', 1, NULL, 'StageProduce',
                '{"scope":"first"}', '{"request":"first"}', ${"1".repeat(64)}, NULL,
                'failed', 0, 2, 3, NULL, NULL, NULL, '2026-07-19T10:01:00.000Z',
                NULL, NULL, 1, 5, '{"failure":"retain parent"}',
                'temporary producer error', 'producer failed', 'retryable',
                '2026-07-19T10:00:00.000Z', '2026-07-19T10:02:00.000Z'
              ),
              (
                'produce-1-r2', 'produce-1', 2, 'produce-1-r1', 'StageProduce',
                '{"scope":"retry"}', '{"request":"retry"}', ${"2".repeat(64)}, NULL,
                'leased', 1, 2, 3, 'worker-2', 'lease-token-2',
                '2026-07-19T12:30:00.000Z', '2026-07-19T12:00:00.000Z',
                '{"workspace":"prepared"}', NULL, 0, 7, '{"success":"advance"}',
                NULL, NULL, NULL, '2026-07-19T11:00:00.000Z',
                '2026-07-19T12:00:00.000Z'
              ),
              (
                'publish-1-r1', 'publish-1', 1, NULL, 'ArtifactPublish',
                '{"artifact":"release"}', '{"publish":"request"}', ${"3".repeat(64)},
                '{"published":true,"url":"https://example.test/artifact"}', 'succeeded', 1,
                1, 4, NULL, NULL, NULL, '2026-07-19T12:10:00.000Z',
                '{"request_id":"external-1"}', '{"status":"published","attempt":1}',
                2, 6, '{"parent":"publication"}', NULL, NULL, NULL,
                '2026-07-19T11:30:00.000Z', '2026-07-19T12:20:00.000Z'
              ),
              (
                'start-1-r1', 'start-1', 1, NULL, 'WorkflowStart',
                '{"workflow":"one"}', '{"start":"manual"}', ${"4".repeat(64)}, NULL,
                'waiting_human', 1, 0, 1, NULL, NULL, NULL,
                '2026-07-19T12:40:00.000Z', NULL, NULL, 0, 3,
                '{"parent":"operator gate"}', NULL, 'operator approval required',
                'operator_required', '2026-07-19T12:30:00.000Z',
                '2026-07-19T12:40:00.000Z'
              )
          `

          const generations = yield* sql<HistoricalGenerationRow>`
            SELECT * FROM qrspi_generations ORDER BY workflow_id, generation
          `
          const operations = yield* sql<Record<string, unknown>>`
            SELECT * FROM workflow_operations
            ORDER BY logical_operation_id, operation_revision, operation_id
          `
          const migrations = yield* sql<MigrationRow>`
            SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
          `
          return { generations, migrations, operations }
        }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
      )

      const upgraded = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`PRAGMA foreign_keys = ON`
          yield* runStoreMigrations

          const readCurrentState = Effect.gen(function* () {
            const generations = yield* sql<UpgradedGenerationRow>`
              SELECT * FROM qrspi_generations ORDER BY workflow_id, generation
            `
            const operations = yield* sql<Record<string, unknown>>`
              SELECT * FROM workflow_operations
              ORDER BY logical_operation_id, operation_revision, operation_id
            `
            const migrations = yield* sql<MigrationRow>`
              SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
            `
            const runtimeCounts = yield* Effect.all(
              runtimeTables.map((table) =>
                sql.unsafe<{ readonly count: number }>(`SELECT count(*) AS count FROM "${table}"`),
              ),
            )
            const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`
            const generation = yield* readTableMetadata("qrspi_generations")
            const workflowOperation = yield* readTableMetadata("workflow_operations")
            return {
              foreignKeyViolations,
              generations,
              generationIndexes: yield* readIndexInventory(generation.indexes),
              migrations,
              operations,
              runtimeCounts,
              workflowOperationIndexes: yield* readIndexInventory(workflowOperation.indexes),
            }
          })

          const afterFirstRun = yield* readCurrentState
          yield* runStoreMigrations
          const afterSecondRun = yield* readCurrentState
          return { afterFirstRun, afterSecondRun }
        }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
      )

      const shippedGenerations: ReadonlyArray<HistoricalGenerationRow> =
        upgraded.afterFirstRun.generations.map(
          ({ current_stage_key, current_stage_run_ordinal, ...historicalRow }) => historicalRow,
        )
      expect(shippedGenerations).toEqual(historical.generations)
      expect(upgraded.afterFirstRun.generations).toEqual(
        historical.generations.map((row) => ({
          ...row,
          current_stage_key: null,
          current_stage_run_ordinal: null,
        })),
      )
      expect(upgraded.afterFirstRun.operations).toEqual(historical.operations)
      expect(upgraded.afterSecondRun.generations).toEqual(upgraded.afterFirstRun.generations)
      expect(upgraded.afterSecondRun.operations).toEqual(upgraded.afterFirstRun.operations)

      expect(historical.migrations).toEqual([
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
      ])
      expect(upgraded.afterFirstRun.migrations).toEqual([
        ...historical.migrations,
        { migration_id: 11, name: "qrspi_stage_runtime_layout" },
      ])
      expect(upgraded.afterSecondRun.migrations).toEqual(upgraded.afterFirstRun.migrations)
      expect(upgraded.afterFirstRun.runtimeCounts.flat()).toEqual(
        runtimeTables.map(() => ({ count: 0 })),
      )
      expect(upgraded.afterSecondRun.runtimeCounts).toEqual(upgraded.afterFirstRun.runtimeCounts)
      expect(upgraded.afterFirstRun.foreignKeyViolations).toEqual([])
      expect(upgraded.afterSecondRun.foreignKeyViolations).toEqual([])
      expect(upgraded.afterFirstRun.generationIndexes).toContainEqual({
        name: "qrspi_generations_current",
        unique: 1,
        partial: 1,
        origin: "c",
        columns: [{ name: "workflow_id", seqno: 0 }],
      })
      expect(upgraded.afterFirstRun.generationIndexes).toContainEqual({
        name: "qrspi_generations_definition",
        unique: 1,
        partial: 0,
        origin: "c",
        columns: [
          { name: "workflow_id", seqno: 0 },
          { name: "generation", seqno: 1 },
          { name: "workflow_definition_sha256", seqno: 2 },
        ],
      })
      expect(upgraded.afterFirstRun.workflowOperationIndexes).toContainEqual({
        name: "workflow_operations_current",
        unique: 1,
        partial: 1,
        origin: "c",
        columns: [{ name: "logical_operation_id", seqno: 0 }],
      })
      expect(upgraded.afterFirstRun.workflowOperationIndexes).toContainEqual({
        name: "workflow_operations_identity_kind",
        unique: 1,
        partial: 0,
        origin: "c",
        columns: [
          { name: "operation_id", seqno: 0 },
          { name: "kind", seqno: 1 },
        ],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
          "(expected_json IS NULL) = (expected_sha256 IS NULL)",
          "(actual_json IS NULL) = (actual_sha256 IS NULL)",
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

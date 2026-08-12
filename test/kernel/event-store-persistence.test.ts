import { expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { WorkflowStoreLive } from "../../src/store"
import { WorkflowStore } from "../../src/store/contracts"
import * as StoreMigrations from "../../src/store/migrations"
import { runWithStore } from "../store/harness"

const createdAt = new Date("2026-08-11T09:00:00.000Z")
test("exports a true through-0010 migrator", () => {
  expect("runStoreMigrationsThrough0010" in StoreMigrations).toBe(true)
})

test("exports the current migration as the true predecessor", () => {
  expect("runStoreMigrationsThrough0011" in StoreMigrations).toBe(true)
})

const runWithDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  return Effect.runPromise(effect.pipe(Effect.provide(database)))
}

const seedRepresentativeLegacyRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO webhook_deliveries (
    delivery_id, event, action, payload, received_at, observation_sequence
  ) VALUES ('legacy-delivery', 'pull_request', 'opened', '{}', ${createdAt.toISOString()}, 1)`
  for (const pullRequestNumber of [1, 2, 3]) {
    yield* sql`INSERT INTO pull_requests (
      repository_id, pull_request_number, installation_id, repository_full_name,
      repository_owner, repository_name, author, base_ref, base_sha, draft,
      head_ref, head_repository_full_name, head_sha, state, generation, updated_at
    ) VALUES (
      42, ${pullRequestNumber}, 91, 'owner/repo', 'owner', 'repo', 'author', 'main',
      ${"a".repeat(40)}, FALSE, 'feature', 'owner/repo', ${"b".repeat(40)},
      'open', 1, ${createdAt.toISOString()}
    )`
  }
  yield* sql`INSERT INTO jobs (
    id, kind, installation_id, repository_id, repository_full_name,
    pull_request_number, author, base_ref, base_sha, expected_head_sha, head_ref,
    head_repository_full_name, generation, review_request_number, state, attempts,
    max_attempts, run_at, lease_owner, lease_until, last_error,
    created_at, updated_at
  ) VALUES
    (1, 'review', 91, 42, 'owner/repo', 1, 'author', 'main', ${"a".repeat(40)},
      ${"b".repeat(40)}, 'feature', 'owner/repo', 1, 1, 'ready', 0, 3,
      ${createdAt.toISOString()}, NULL, NULL, NULL,
      ${createdAt.toISOString()}, ${createdAt.toISOString()}),
    (2, 'review', 91, 42, 'owner/repo', 2, 'author', 'main', ${"a".repeat(40)},
      ${"b".repeat(40)}, 'feature', 'owner/repo', 1, 1, 'leased', 1, 3,
      ${createdAt.toISOString()}, 'legacy-worker',
      '2026-08-11T10:00:00.000Z', NULL, ${createdAt.toISOString()}, ${createdAt.toISOString()}),
    (3, 'review', 91, 42, 'owner/repo', 3, 'author', 'main', ${"a".repeat(40)},
      ${"b".repeat(40)}, 'feature', 'owner/repo', 1, 1, 'retry_scheduled', 1, 3,
      '2026-08-12T09:00:00.000Z', NULL, NULL, 'retry later',
      ${createdAt.toISOString()}, ${createdAt.toISOString()})`
  yield* sql`INSERT INTO agent_executions (
    session_reference_id, job_id, attempt, lease_token, launch_intent_json,
    session_reference_json, state, created_at, updated_at
  ) VALUES (
    'legacy-session', 2, 1, '1234567890abcdef', '{}', '{}', 'session_ready',
    ${createdAt.toISOString()}, ${createdAt.toISOString()}
  )`
  yield* sql`INSERT INTO workflow_operations (
    operation_id, logical_operation_id, operation_revision, kind, scope_json,
    input_json, input_sha256, state, is_current, attempt, max_attempts, run_at,
    lease_owner, lease_token, lease_until, observation_attempts,
    max_observation_attempts, parent_effect_json,
    created_at, updated_at
  ) VALUES
    ('waiting-external', 'waiting-external', 1, 'PullRequestPublish', '{}', '{}',
      ${"c".repeat(64)}, 'waiting_external', 1, 0, 3, ${createdAt.toISOString()},
      NULL, NULL, NULL, 0, 3, '{}', ${createdAt.toISOString()}, ${createdAt.toISOString()}),
    ('waiting-human', 'waiting-human', 1, 'TargetReconcile', '{}', '{}',
      ${"d".repeat(64)}, 'waiting_human', 1, 0, 3, ${createdAt.toISOString()},
      NULL, NULL, NULL, 0, 3, '{}', ${createdAt.toISOString()}, ${createdAt.toISOString()}),
    ('leased-operation', 'leased-operation', 1, 'StageProduce', '{}', '{}',
      ${"a".repeat(64)}, 'leased', 1, 1, 3, ${createdAt.toISOString()},
      'legacy-worker', '1234567890abcdef', '2026-08-11T13:00:00.000Z',
      0, 3, '{}', ${createdAt.toISOString()}, ${createdAt.toISOString()})`
  yield* sql`INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
    VALUES ('legacy-workflow', 'task/legacy', ${createdAt.toISOString()}, ${createdAt.toISOString()})`
  yield* sql`INSERT INTO qrspi_ticket_revisions (
    workflow_id, ticket_revision_sha256, revision_json, checked_at
  ) VALUES ('legacy-workflow', ${"e".repeat(64)}, '{}', ${createdAt.toISOString()})`
  yield* sql`INSERT INTO qrspi_workflow_definitions (
    definition_sha256, definition_json, created_at
  ) VALUES (${"f".repeat(64)}, '{}', ${createdAt.toISOString()})`
  yield* sql`INSERT INTO qrspi_generations (
    workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
    root_sha, current_head_sha, ticket_revision_sha256, workflow_definition_sha256,
    state, is_current, created_at, updated_at, generation_format
  ) VALUES (
    'legacy-workflow', 1, '{}', 'main', ${"a".repeat(40)}, 'task/legacy',
    ${"b".repeat(40)}, ${"b".repeat(40)}, ${"e".repeat(64)}, ${"f".repeat(64)},
    'running', 1, ${createdAt.toISOString()}, ${createdAt.toISOString()}, 'legacy'
  )`
  yield* sql`INSERT INTO qrspi_stage_definitions (
    stage_definition_sha256, workflow_definition_sha256, stage_key, sequence_position,
    definition_json, contract_name, contract_version, contract_registration_sha256,
    harness_name, harness_version, harness_registration_sha256, created_at
  ) VALUES (
    ${"1".repeat(64)}, ${"f".repeat(64)}, 'questions', 1, '{}', 'questions', 1,
    ${"2".repeat(64)}, 'default', 1, ${"3".repeat(64)}, ${createdAt.toISOString()}
  )`
})

const legacySnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    jobs: yield* sql`SELECT id, state, attempts, run_at, lease_owner,
      lease_until, last_error FROM jobs ORDER BY id`,
    sessions: yield* sql`SELECT session_reference_id, state, lease_token,
      created_at, updated_at FROM agent_executions ORDER BY session_reference_id`,
    operations: yield* sql`SELECT operation_id, state, run_at, lease_owner,
      lease_token, lease_until, created_at, updated_at
      FROM workflow_operations ORDER BY operation_id`,
    generations: yield* sql`SELECT workflow_id, generation, state, is_current,
      created_at, updated_at FROM qrspi_generations`,
    stageDefinitions: yield* sql`SELECT stage_definition_sha256, stage_key,
      sequence_position, contract_name, harness_name, created_at
      FROM qrspi_stage_definitions`,
  }
})

test("migration 11 preserves representative legacy state and behavior", async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* StoreMigrations.runStoreMigrationsThrough0010
      yield* seedRepresentativeLegacyRows
      const before = yield* legacySnapshot
      yield* StoreMigrations.runStoreMigrations
      const after = yield* legacySnapshot
      const kernelCounts = yield* sql`SELECT
        (SELECT count(*) FROM kernel_workflow_instances) AS instances,
        (SELECT count(*) FROM kernel_events) AS events,
        (SELECT count(*) FROM kernel_waits) AS waits,
        (SELECT count(*) FROM kernel_wait_event_deliveries) AS deliveries`
      const foreignKeys = yield* sql`PRAGMA foreign_key_check`
      const integrity = yield* sql`PRAGMA integrity_check`
      return { before, after, kernelCounts, foreignKeys, integrity }
    }),
  )

  expect(result.after).toEqual(result.before)
  expect(result.kernelCounts).toEqual([{ instances: 0, events: 0, waits: 0, deliveries: 0 }])
  expect(result.foreignKeys).toEqual([])
  expect(result.integrity).toEqual([{ integrity_check: "ok" }])
})

test("migration 11 rolls back every object and ledger row after a mid-DDL conflict", async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* StoreMigrations.runStoreMigrationsThrough0010
      yield* sql`CREATE TABLE kernel_events (conflict TEXT) STRICT`
      const failed = yield* StoreMigrations.runStoreMigrations.pipe(Effect.exit)
      const afterFailure = yield* sql`SELECT name FROM sqlite_master
        WHERE name LIKE 'kernel_%' ORDER BY name`
      const failedLedger = yield* sql`SELECT migration_id FROM effect_sql_migrations
        WHERE migration_id = 11`
      yield* sql`DROP TABLE kernel_events`
      yield* StoreMigrations.runStoreMigrations
      const afterRetry = yield* sql`SELECT name FROM pragma_table_list
        WHERE name IN (
          'kernel_workflow_instances', 'kernel_events', 'kernel_waits',
          'kernel_wait_event_deliveries'
        ) ORDER BY name`
      const retryLedger = yield* sql`SELECT migration_id FROM effect_sql_migrations
        WHERE migration_id = 11`
      return { failed, afterFailure, failedLedger, afterRetry, retryLedger }
    }),
  )

  expect(result.failed._tag).toBe("Failure")
  expect(result.afterFailure).toEqual([{ name: "kernel_events" }])
  expect(result.failedLedger).toEqual([])
  expect(result.afterRetry).toHaveLength(4)
  expect(result.retryLedger).toEqual([{ migration_id: 11 }])
})

test("owns four strict SQLite tables in migration 11", async () => {
  const result = await runWithStore(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 11
      `
      const tables = yield* sql<{ readonly name: string; readonly strict: number }>`
        SELECT name, strict FROM pragma_table_list
        WHERE name IN (
          'kernel_workflow_instances', 'kernel_events', 'kernel_waits',
          'kernel_wait_event_deliveries'
        )
        ORDER BY name
      `
      return { migrations, tables }
    }),
  )

  expect(result.migrations).toEqual([{ migration_id: 11, name: "kernel_event_wait_store" }])
  expect(result.tables).toHaveLength(4)
  expect(result.tables.every(({ strict }) => strict === 1)).toBe(true)
})

test("migration 11 indexes ready delivery recovery", async () => {
  const indexes = await runWithStore(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql`SELECT name FROM pragma_index_list('kernel_wait_event_deliveries')
        WHERE name = 'kernel_deliveries_ready'`
    }),
  )

  expect(indexes).toEqual([{ name: "kernel_deliveries_ready" }])
})

test("legacy work can still be claimed and completed after migration 11", async () => {
  const filename = `${process.cwd()}/kernel-legacy-${crypto.randomUUID()}.sqlite`
  try {
    const firstDatabase = SqliteClient.layer({ filename })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* StoreMigrations.runStoreMigrationsThrough0010
        yield* seedRepresentativeLegacyRows
        yield* StoreMigrations.runStoreMigrations
      }).pipe(Effect.provide(firstDatabase)),
    )

    const secondDatabase = SqliteClient.layer({ filename })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const sql = yield* SqlClient.SqlClient
        const claimed = yield* store.claimNextJob({
          workerId: "post-migration-worker",
          now: createdAt,
          leaseDurationMs: 60_000,
        })
        const completed =
          claimed === null
            ? "missing"
            : yield* store.completeReviewJob({
                jobId: claimed.id,
                workerId: "post-migration-worker",
                completedAt: new Date("2026-08-11T09:00:30.000Z"),
                review: { verdict: "pass", summary: "Passed.", findings: [] },
                autoFix: false,
              })
        const rows = yield* sql`SELECT state FROM jobs WHERE id = 1`
        return { claimed, completed, rows }
      }).pipe(Effect.provide(WorkflowStoreLive.pipe(Layer.provideMerge(secondDatabase)))),
    )
    expect(Number(result.claimed?.id)).toBe(1)
    expect(result.completed).toBe("completed")
    expect(result.rows).toEqual([{ state: "succeeded" }])
  } finally {
    await Bun.file(filename)
      .delete()
      .catch(() => undefined)
    await Bun.file(`${filename}-shm`)
      .delete()
      .catch(() => undefined)
    await Bun.file(`${filename}-wal`)
      .delete()
      .catch(() => undefined)
  }
})

test("migration 12 preserves realistic predecessor state and owns strict job tables", async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* StoreMigrations.runStoreMigrationsThrough0011
      yield* seedRepresentativeLegacyRows
      const before = yield* legacySnapshot
      yield* StoreMigrations.runStoreMigrations
      const after = yield* legacySnapshot
      const tables = yield* sql<{ readonly name: string; readonly strict: number }>`
        SELECT name, strict FROM pragma_table_list
        WHERE name IN ('kernel_workflow_jobs', 'kernel_workflow_job_results')
        ORDER BY name
      `
      const ledger = yield* sql`SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id = 12`
      const foreignKeys = yield* sql`PRAGMA foreign_key_check`
      const integrity = yield* sql`PRAGMA integrity_check`
      return { before, after, tables, ledger, foreignKeys, integrity }
    }),
  )

  expect(result.after).toEqual(result.before)
  expect(result.tables).toEqual([
    { name: "kernel_workflow_job_results", strict: 1 },
    { name: "kernel_workflow_jobs", strict: 1 },
  ])
  expect(result.ledger).toEqual([{ migration_id: 12, name: "kernel_workflow_jobs" }])
  expect(result.foreignKeys).toEqual([])
  expect(result.integrity).toEqual([{ integrity_check: "ok" }])
})

test("migration 12 rolls back all new objects and its ledger row before a successful retry", async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* StoreMigrations.runStoreMigrationsThrough0011
      yield* sql`CREATE TABLE kernel_workflow_job_results (conflict TEXT) STRICT`
      const failed = yield* StoreMigrations.runStoreMigrations.pipe(Effect.exit)
      const afterFailure = yield* sql`SELECT name FROM sqlite_master
        WHERE name LIKE 'kernel_workflow_job%' ORDER BY name`
      const failedLedger = yield* sql`SELECT migration_id FROM effect_sql_migrations
        WHERE migration_id = 12`
      yield* sql`DROP TABLE kernel_workflow_job_results`
      yield* StoreMigrations.runStoreMigrations
      const afterRetry = yield* sql`SELECT name FROM pragma_table_list
        WHERE name IN ('kernel_workflow_jobs', 'kernel_workflow_job_results') ORDER BY name`
      const retryLedger = yield* sql`SELECT migration_id FROM effect_sql_migrations
        WHERE migration_id = 12`
      const foreignKeys = yield* sql`PRAGMA foreign_key_check`
      const integrity = yield* sql`PRAGMA integrity_check`
      return {
        failed,
        afterFailure,
        failedLedger,
        afterRetry,
        retryLedger,
        foreignKeys,
        integrity,
      }
    }),
  )

  expect(result.failed._tag).toBe("Failure")
  expect(result.afterFailure).toEqual([{ name: "kernel_workflow_job_results" }])
  expect(result.failedLedger).toEqual([])
  expect(result.afterRetry).toHaveLength(2)
  expect(result.retryLedger).toEqual([{ migration_id: 12 }])
  expect(result.foreignKeys).toEqual([])
  expect(result.integrity).toEqual([{ integrity_check: "ok" }])
})

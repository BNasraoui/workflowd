import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { runStoreMigrations, runStoreMigrationsThrough0012 } from "../../src/store/migrations"

describe("migration 13: kernel session store", () => {
  test("upgrades the predecessor without losing data and creates strict session tables", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runStoreMigrationsThrough0012
        yield* sql`INSERT INTO kernel_workflow_instances (
          instance_id, workflow_type, workflow_version, workflow_key, payload_json,
          event_cursor, created_at
        ) VALUES ('preserved', 'test', 1, 'key', '{}', 0, '2026-08-12T10:00:00.000Z')`
        yield* runStoreMigrations
        const tables = yield* sql<{ readonly name: string; readonly strict: number }>`
          SELECT name, strict FROM pragma_table_list WHERE name IN (
            'kernel_working_resources', 'kernel_sessions', 'kernel_resume_requests',
            'kernel_resume_attempts', 'kernel_resume_checkpoints', 'kernel_resume_results',
            'kernel_resume_observations', 'kernel_cleanup_requests', 'kernel_cleanup_attempts',
            'kernel_cleanup_outcomes'
          ) ORDER BY name`
        const preserved = yield* sql`SELECT instance_id FROM kernel_workflow_instances`
        const migrations = yield* sql`SELECT migration_id, name FROM effect_sql_migrations
          WHERE migration_id >= 12 ORDER BY migration_id`
        return { migrations, preserved, tables }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )

    expect(result.migrations).toEqual([
      { migration_id: 12, name: "kernel_workflow_jobs" },
      { migration_id: 13, name: "kernel_session_store" },
    ])
    expect(result.preserved).toEqual([{ instance_id: "preserved" }])
    expect(result.tables).toHaveLength(10)
    expect(result.tables.every(({ strict }) => strict === 1)).toBe(true)
  })

  test("rolls back all 0013 changes when schema creation fails", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runStoreMigrationsThrough0012
        yield* sql`INSERT INTO kernel_workflow_instances (
          instance_id, workflow_type, workflow_version, workflow_key, payload_json,
          event_cursor, created_at
        ) VALUES ('preserved', 'test', 1, 'key', '{}', 0, '2026-08-12T10:00:00.000Z')`
        yield* sql`CREATE TABLE kernel_sessions (sentinel TEXT) STRICT`
        const failed = yield* Effect.exit(runStoreMigrations)
        const tables = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_list
          WHERE name IN ('kernel_working_resources', 'kernel_sessions') ORDER BY name`
        const preserved = yield* sql`SELECT instance_id FROM kernel_workflow_instances`
        const migration = yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 13`
        return { failed, migration, preserved, tables }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )

    expect(result.failed._tag).toBe("Failure")
    expect(result.migration).toEqual([])
    expect(result.preserved).toEqual([{ instance_id: "preserved" }])
    expect(result.tables).toEqual([{ name: "kernel_sessions" }])
  })

  test("preserves representative legacy, QRSPI, event, wait, and job work through upgrade", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runStoreMigrationsThrough0012
        const at = "2026-08-12T10:00:00.000Z"
        yield* sql`INSERT INTO webhook_deliveries (delivery_id, event, payload, received_at)
        VALUES ('delivery', 'test', '{}', ${at})`
        yield* sql`INSERT INTO pull_requests (repository_id, pull_request_number, installation_id,
        repository_full_name, repository_owner, repository_name, author, base_ref, base_sha, draft,
        head_ref, head_repository_full_name, head_sha, state, generation, updated_at) VALUES
        (1, 1, 1, 'o/r', 'o', 'r', 'a', 'main', ${"a".repeat(40)}, 0, 'head', 'o/r',
        ${"b".repeat(40)}, 'open', 1, ${at})`
        yield* sql`INSERT INTO jobs (id, kind, installation_id, repository_id, repository_full_name,
        pull_request_number, author, base_ref, base_sha, expected_head_sha, head_ref,
        head_repository_full_name, generation, review_request_number, state, attempts, max_attempts,
        run_at, cancel_requested, created_at, updated_at) VALUES (1, 'review', 1, 1, 'o/r', 1, 'a',
        'main', ${"a".repeat(40)}, ${"b".repeat(40)}, 'head', 'o/r', 1, 1, 'ready', 0, 3,
        ${at}, 0, ${at}, ${at})`
        yield* sql`INSERT INTO qrspi_workflows (workflow_id, branch_name, created_at, updated_at)
        VALUES ('workflow', 'branch', ${at}, ${at})`
        const definition = "d".repeat(64)
        const ticket = "e".repeat(64)
        const stage = "f".repeat(64)
        yield* sql`INSERT INTO qrspi_ticket_revisions (workflow_id, ticket_revision_sha256,
          revision_json, checked_at) VALUES ('workflow', ${ticket}, '{}', ${at})`
        yield* sql`INSERT INTO qrspi_workflow_definitions (definition_sha256, definition_json,
          created_at) VALUES (${definition}, '{}', ${at})`
        yield* sql`INSERT INTO qrspi_stage_definitions (stage_definition_sha256,
          workflow_definition_sha256, stage_key, sequence_position, definition_json, contract_name,
          contract_version, contract_registration_sha256, harness_name, harness_version,
          harness_registration_sha256, created_at) VALUES (${stage}, ${definition}, 'stage', 1, '{}',
          'contract', 1, ${"a".repeat(64)}, 'harness', 1, ${"b".repeat(64)}, ${at})`
        yield* sql`INSERT INTO qrspi_generations (workflow_id, generation, repository_json, base_ref,
          base_sha, head_ref, root_sha, current_head_sha, ticket_revision_sha256,
          workflow_definition_sha256, state, is_current, created_at, updated_at, generation_format)
          VALUES ('workflow', 1, '{}', 'main', ${"a".repeat(40)}, 'head', ${"b".repeat(40)},
          ${"b".repeat(40)}, ${ticket}, ${definition}, 'running', 1, ${at}, ${at}, 'stage_snapshots_v1')`
        yield* sql`INSERT INTO workflow_operations (operation_id, logical_operation_id,
          operation_revision, kind, scope_json, input_json, input_sha256, state, is_current, attempt,
          max_attempts, run_at, observation_attempts, max_observation_attempts, parent_effect_json,
          created_at, updated_at) VALUES ('operation', 'logical', 1, 'StageProduce', '{}', '{}',
          ${"c".repeat(64)}, 'ready', 1, 0, 2, ${at}, 0, 2, '{}', ${at}, ${at})`
        yield* sql`INSERT INTO agent_executions (session_reference_id, job_id, attempt, lease_token,
          launch_intent_json, state, created_at, updated_at) VALUES ('agent-session', 1, 1,
          '0123456789abcdef', '{}', 'launch_intent', ${at}, ${at})`
        yield* sql`INSERT INTO kernel_workflow_instances (instance_id, workflow_type, workflow_version,
        workflow_key, payload_json, event_cursor, created_at) VALUES ('instance', 'test', 1, 'key',
        '{}', 0, ${at})`
        yield* sql`INSERT INTO kernel_events (sequence, source, source_event_id, event_type, event_version,
        event_key, correlation, payload_json, recorded_at) VALUES (1, 'test', 'event', 'signal', 1,
        'key', 'correlation', '{}', ${at})`
        yield* sql`INSERT INTO kernel_waits (instance_id, wait_id, event_type, event_version, event_key,
        correlation, after_sequence, state, registered_at) VALUES ('instance', 'wait', 'signal', 1,
        'key', 'correlation', 0, 'matched', ${at})`
        yield* sql`INSERT INTO kernel_wait_event_deliveries (instance_id, wait_id, event_sequence, state,
        delivered_at) VALUES ('instance', 'wait', 1, 'consumed', ${at})`
        yield* sql`INSERT INTO kernel_workflow_jobs (job_id, instance_id, wait_id, event_sequence,
        expected_cursor, input_version, input_json, state, attempt, max_attempts, run_at, created_at,
        updated_at) VALUES ('kernel-job', 'instance', 'wait', 1, 0, 1, '{}', 'ready', 0, 3,
        ${at}, ${at}, ${at})`
        yield* sql`INSERT INTO kernel_workflow_jobs (job_id, instance_id, wait_id, event_sequence,
          expected_cursor, input_version, input_json, state, attempt, max_attempts, run_at, created_at,
          updated_at) VALUES ('kernel-completed', 'instance', 'wait', 1, 0, 1, '{}', 'succeeded', 1, 3,
          ${at}, ${at}, ${at})`
        yield* sql`INSERT INTO kernel_workflow_job_results (result_id, job_id, attempt, worker_id,
          claim_token, lease_until, result_version, result_json, completed_at) VALUES ('old-result',
          'kernel-completed', 1, 'old-worker', 'old-token', '2026-08-12T10:01:00.000Z', 1, '{}', ${at})`
        yield* runStoreMigrations
        const legacyClaim = yield* sql`UPDATE jobs SET state = 'leased', attempts = 1,
        lease_owner = 'worker', lease_until = '2026-08-12T10:01:00.000Z' WHERE id = 1 AND state = 'ready'
        RETURNING id`
        const legacyComplete = yield* sql`UPDATE jobs SET state = 'succeeded', lease_owner = NULL,
        lease_until = NULL WHERE id = 1 AND state = 'leased' RETURNING id`
        const kernelClaim =
          yield* sql`UPDATE kernel_workflow_jobs SET state = 'leased', attempt = 1,
        lease_worker_id = 'worker', claim_token = 'token', lease_until = '2026-08-12T10:01:00.000Z'
        WHERE job_id = 'kernel-job' AND state = 'ready' RETURNING job_id`
        yield* sql`INSERT INTO kernel_workflow_job_results (result_id, job_id, attempt, worker_id,
        claim_token, lease_until, result_version, result_json, completed_at) VALUES ('result',
        'kernel-job', 1, 'worker', 'token', '2026-08-12T10:01:00.000Z', 1, '{}', ${at})`
        const kernelComplete = yield* sql`UPDATE kernel_workflow_jobs SET state = 'succeeded',
        lease_worker_id = NULL, claim_token = NULL, lease_until = NULL WHERE job_id = 'kernel-job'
        AND state = 'leased' RETURNING job_id`
        const preserved = yield* sql`SELECT
          (SELECT count(*) FROM agent_executions) AS agent,
          (SELECT count(*) FROM qrspi_ticket_revisions) AS ticket,
          (SELECT count(*) FROM qrspi_stage_definitions) AS stage,
          (SELECT count(*) FROM qrspi_generations) AS generation,
          (SELECT count(*) FROM workflow_operations) AS operation,
          (SELECT count(*) FROM kernel_workflow_job_results) AS kernel_results`
        return { kernelClaim, kernelComplete, legacyClaim, legacyComplete, preserved }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )

    expect(result.legacyClaim).toEqual([{ id: 1 }])
    expect(result.legacyComplete).toEqual([{ id: 1 }])
    expect(result.kernelClaim).toEqual([{ job_id: "kernel-job" }])
    expect(result.kernelComplete).toEqual([{ job_id: "kernel-job" }])
    expect(result.preserved).toEqual([
      { agent: 1, ticket: 1, stage: 1, generation: 1, operation: 1, kernel_results: 2 },
    ])
  })
})

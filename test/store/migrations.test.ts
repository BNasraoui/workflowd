import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect, Either, Layer } from "effect"
import { makeCurrentnessPolicy } from "../../src/store/currentness"
import {
  commandClaimCandidate,
  reconciliationClaimCandidate,
} from "../../src/store/internal-claim-queries"
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
            'commands', 'reconciliations', 'agent_executions'
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
    ])
    expect(result.tables).toHaveLength(7)
    expect(result.tables.every((table) => table.strict === 1)).toBe(true)
    expect(result.foreignKeys).toEqual([{ foreign_keys: 1 }])
    expect(result.busyTimeout).toEqual([{ timeout: 5000 }])
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

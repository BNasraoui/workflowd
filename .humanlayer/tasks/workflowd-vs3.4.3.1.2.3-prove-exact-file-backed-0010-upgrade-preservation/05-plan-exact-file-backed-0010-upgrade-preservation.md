---
task: workflowd-vs3.4.3.1.2.3-prove-exact-file-backed-0010-upgrade-preservation
type: plan
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: da8d81befab2d29bd6f9459857672fbaa6a17a3b
---

# Prove Exact File-Backed 0010 Upgrade Preservation Implementation Plan

## Overview

Replace the current in-memory, same-layer migration smoke test with one process-style integration test over a real SQLite file. The test will create diverse Generation and WorkflowOperation history through migration `0010`, capture complete ordered snapshots, close that historical SQLite layer, open the same file through a separately constructed current layer, and prove that append-only migration `0011` preserves every shipped value while adding only null Generation runtime cursors and no runtime authority.

This plan implements Bead `workflowd-vs3.4.3.1.2.3` and the accepted Structure in `01-structure-outline-exact-upgrade-preservation.md`. Its Design authority is the accepted ancestor revision 3 in `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md`, especially the append-only, byte-for-byte preservation, zero-inference, and file-backed restart requirements at lines 204-218 and 345-359.

## Current State Analysis

Migration `0010` adds `generation_format` with historical literals `legacy` and `stage_snapshots_v1`, and `runStoreMigrationsThrough0010` already exposes that exact frontier (`src/store/migrations.ts:610-642`). Migration `0011` reconstructs `qrspi_generations`, copies all fifteen historical columns explicitly, supplies null values for the two new cursor columns, recreates Generation indexes, creates the twelve-table inactive runtime layout, and adds the WorkflowOperation identity/kind index (`src/store/migrations.ts:644-1185`).

The existing preservation test (`test/store/migrations.test.ts:887-937`) covers only one Generation in `:memory:`, runs both migrators in one layer, checks two runtime tables, and does not seed or snapshot WorkflowOperations. It therefore cannot prove connection closure, file persistence, complete row preservation, ledger idempotence, the full no-authority table inventory, or retained indexes.

### Key Discoveries

- `qrspi_generations` has fifteen shipped through-`0010` columns, including textual JSON, state/currentness, timestamps, and `generation_format`; `0011` adds only `current_stage_key` and `current_stage_run_ordinal` (`src/store/migrations.ts:502-526`, `610-617`, `761-817`).
- `workflow_operations` has twenty-seven shipped columns covering logical and physical identity, retry lineage, kind, JSON and hash values, currentness, leases, external effects, observations, terminal metadata, and timestamps (`src/store/migrations.ts:423-483`). Migration `0011` does not rewrite this table.
- The test file already provides `readTableMetadata`, `readIndexInventory`, and the canonical twelve-entry `runtimeTables` inventory (`test/store/migrations.test.ts:61-108`, `663-676`).
- Existing assertions define the exact required `qrspi_generations_current`, `qrspi_generations_definition`, and `workflow_operations_identity_kind` index shapes (`test/store/migrations.test.ts:840-872`, `1685-1723`). The pre-existing `workflow_operations_current` partial index is defined at `src/store/migrations.ts:485-487`.
- The repository's local failure-safe file lifecycle is `mkdtemp` plus a `try/finally` containing `rm(directory, { recursive: true, force: true })` (`test/store/reconciliation.test.ts:425-530`).
- Two sequential `Effect.runPromise` calls, each provided a newly constructed `SqliteClient.layer({ filename })`, establish closure and reopening of the same file (`test/qrspi/workflow-start.test.ts:1955-1995`; `test/store/reconciliation.test.ts:429-521`).
- Complete SQL row preservation is already asserted with `sql<Record<string, unknown>>\`SELECT * ...\`` and direct equality (`test/qrspi/stage-replay.test.ts:603-623`).
- The migration ledger query and exact names are established at `test/store/migrations.test.ts:218-257`; the historical frontier must contain exactly rows 1 through 10 before `0011_qrspi_stage_runtime_layout` is appended once.

## Desired End State

`test/store/migrations.test.ts` contains one file-backed test replacing the limited preservation smoke test. It creates valid, diverse through-`0010` history, snapshots every shipped Generation and WorkflowOperation column in deterministic order, closes the old layer, reopens the same file with a fresh current layer, and proves:

- all fifteen pre-existing Generation values and identities are unchanged;
- every original `generation_format` remains unchanged and both new cursor columns are null;
- all twenty-seven WorkflowOperation values and identities are unchanged;
- the exact ten-row migration ledger is retained as a prefix and exactly one row 11 is appended;
- rerunning the current migrator changes neither the ledger nor either data snapshot;
- all twelve runtime tables are empty;
- `PRAGMA foreign_key_check` is empty;
- the two required Generation indexes and two required WorkflowOperation indexes remain present with exact columns, uniqueness, and partiality; and
- the temporary directory is removed whether setup, migration, query, or assertion succeeds or fails.

The focused migration test passes with `bun test test/store/migrations.test.ts`, and the repository passes `bun run check` and `git diff --check`.

## What We're NOT Doing

- Adding the identity-spine or tagged-payload SQL rejection matrices owned by sibling Beads.
- Adding runtime rows merely to inspect the inactive schema.
- Adding typed aggregate Schemas, store methods, runtime APIs, claim or transition behavior, bootstrap, quarantine, or legacy conversion.
- Editing migrations `0001` through `0010` or adding a later conversion migration.
- Recomputing semantic hashes or parsing stored JSON before comparison; preservation is exact SQLite value equality, including JSON text.
- Adding a shared temporary-database harness for this single test.
- Treating this child as the complete parent migration release gate before both sibling SQL-rejection outcomes pass.

## Implementation Approach

Use test-driven verification against the current `0011`: first replace the smoke test with the complete file-backed proof and run it unchanged against production migration code. Keep the entire lifecycle and all assertions inside one `try/finally`, but use two separate awaited `Effect.runPromise` calls so completion of the first scoped SQLite layer is the explicit close boundary.

The historical call will migrate only through `0010`, insert valid parent records, two Generations spanning both historical formats, and several WorkflowOperations spanning retry, lease, effect, output, terminal, null, and populated values. It will return complete ordered snapshots and the exact ten-row ledger. The current call will create a fresh layer, run `runStoreMigrations`, collect one complete post-upgrade state, rerun the same migrator, and collect it again. Assertions will compare the two current states for idempotence, strip only the two newly introduced Generation cursors before comparing historical values, compare WorkflowOperations directly, and verify all no-authority and structural postconditions.

If this red test demonstrates a real preservation defect, correct only the failing statement inside the existing append-only `qrspiStageRuntimeLayout`. Do not make speculative production edits.

---

## Phase 1: Prove the Complete File-Backed Upgrade Boundary

### Overview

Replace the current preservation smoke test with the complete accepted upgrade proof. This is one phase because fixture construction, the close/reopen boundary, exact snapshots, migration idempotence, and no-authority postconditions all share one database file and together form the evidence.

### Changes Required

#### 1.1 Add local file lifecycle and complete snapshot types

**File**: `test/store/migrations.test.ts`

**Changes**: Add the standard Node temporary-file imports beside the Bun test imports. Define local row types immediately above the replacement test, or use `Record<string, unknown>` where that keeps the test clearer. The Generation post-upgrade type must make the two new nullable cursors explicit so the test can remove exactly those fields and no others.

```diff
 import { describe, expect, test } from "bun:test"
+import { mkdtemp, rm } from "node:fs/promises"
+import { tmpdir } from "node:os"
+import { join } from "node:path"
 import { SqlClient } from "@effect/sql"
```

```ts
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
```

Use `sql<Record<string, unknown>>` for WorkflowOperation snapshots because the proof intentionally compares every physical SQL column and does not consume these rows as a domain model. Do not introduce an incomplete projection that could silently omit a shipped field.

#### 1.2 Build diverse valid history through `0010` and capture the before-state

**File**: `test/store/migrations.test.ts`

**Changes**: Replace `preserves through-0010 Generation values without inferring runtime facts` at the current lines 887-937. Create one directory and database filename before entering `try`; keep every assertion in the `try` and remove the directory in `finally` with both `recursive` and `force`.

The first `Effect.runPromise` must construct its own `SqliteClient.layer({ filename })`, enable foreign keys, run only `runStoreMigrationsThrough0010`, seed parent rows, seed history, and return snapshots. Completion of this awaited call must occur before constructing the current layer.

```ts
test("preserves complete through-0010 history across a fresh file-backed layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-migration-"))
  const filename = join(directory, "workflowd.db")

  try {
    const historical = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* runStoreMigrationsThrough0010

        // Insert parents, Generations, and WorkflowOperations here.

        const generations = yield* sql<HistoricalGenerationRow>`
          SELECT * FROM qrspi_generations
          ORDER BY workflow_id, generation
        `
        const operations = yield* sql<Record<string, unknown>>`
          SELECT * FROM workflow_operations
          ORDER BY logical_operation_id, operation_revision, operation_id
        `
        const migrations = yield* sql<MigrationRow>`
          SELECT migration_id, name
          FROM effect_sql_migrations
          ORDER BY migration_id
        `
        return { generations, migrations, operations }
      }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
    )

    // Fresh current-layer call and assertions follow.
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
```

Insert at least two Generations under one workflow so the fixture exercises one historical noncurrent terminal row and one current nonterminal row without violating `qrspi_generations_current`. Use distinct repository JSON text, refs, 40- and 64-character SHA lengths, states, timestamps, and both shipped formats:

```sql
INSERT INTO qrspi_generations (
  workflow_id, generation, repository_json, base_ref, base_sha, head_ref,
  root_sha, current_head_sha, ticket_revision_sha256,
  workflow_definition_sha256, state, is_current, created_at, updated_at,
  generation_format
) VALUES
  (
    'workflow-1', 1, '{"repository":"historical"}', 'release/1',
    /* distinct valid SHA and authority values */, 'completed', 0,
    '2026-07-19T10:00:00.000Z', '2026-07-19T10:30:00.000Z', 'legacy'
  ),
  (
    'workflow-1', 2, '{"repository":"current","renamed":true}', 'main',
    /* distinct valid SHA and authority values */, 'waiting_human', 1,
    '2026-07-19T11:00:00.000Z', '2026-07-19T12:00:00.000Z',
    'stage_snapshots_v1'
  );
```

Seed WorkflowOperations with explicit values for all twenty-seven columns. Use at least these valid rows:

- revision 1 of one `StageProduce` logical operation: noncurrent `failed`, null `retry_of`, null lease/output/effect observation values, populated `last_error`, `terminal_failure_reason`, and `terminal_retry_policy = 'retryable'`;
- revision 2 of that same logical operation: current `leased`, `retry_of` revision 1, a complete `lease_owner`/`lease_token`/`lease_until` tuple, distinct JSON/hash/timestamps, and no terminal metadata;
- one current `ArtifactPublish` operation in `succeeded`: populated output JSON, external intent, external observation, parent effect, observation counters, and distinct timestamps;
- one current `WorkflowStart` in `waiting_human`: populated terminal reason with `terminal_retry_policy = 'operator_required'`, proving preservation of that shipped special-case constraint.

Insert retry revision 1 before revision 2, use a distinct logical ID for each other current operation, keep `attempt <= max_attempts`, and keep lease columns all null for every non-`leased` row. The explicit insert should retain the complete column list:

```ts
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
      NULL, NULL, 1, 5, '{"failure":"retain parent"}', 'temporary producer error',
      'producer failed', 'retryable',
      '2026-07-19T10:00:00.000Z', '2026-07-19T10:02:00.000Z'
    ),
    (
      'produce-1-r2', 'produce-1', 2, 'produce-1-r1', 'StageProduce',
      '{"scope":"retry"}', '{"request":"retry"}', ${"2".repeat(64)}, NULL,
      'leased', 1, 2, 3, 'worker-2', 'lease-token-2',
      '2026-07-19T12:30:00.000Z', '2026-07-19T12:00:00.000Z',
      '{"workspace":"prepared"}', NULL, 0, 7, '{"success":"advance"}', NULL,
      NULL, NULL, '2026-07-19T11:00:00.000Z', '2026-07-19T12:00:00.000Z'
    )
  /* Add the succeeded ArtifactPublish and waiting_human WorkflowStart rows. */
`
```

Before leaving the historical layer, assert or later compare that `historical.migrations` is the exact ten-row known ledger, not merely length 10. This makes the post-upgrade prefix check meaningful.

#### 1.3 Reopen through a fresh current layer and collect idempotent postconditions

**File**: `test/store/migrations.test.ts`

**Changes**: After the historical `Effect.runPromise` has returned, start a second `Effect.runPromise` with a newly evaluated `SqliteClient.layer({ filename })`. Enable foreign keys again because the pragma is connection-local. Run `runStoreMigrations`, collect the complete state, rerun `runStoreMigrations` in the same fresh layer, and collect the same state again.

Keep a local `readCurrentState` Effect inside the second generator so the first-run and rerun observations are identical in scope. It must read ordered complete data snapshots, the ordered ledger, cursor fields, all runtime-table counts, foreign-key violations, and index inventories.

```ts
const upgraded = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* runStoreMigrations

    const readCurrentState = Effect.gen(function* () {
      const generations = yield* sql<UpgradedGenerationRow>`
        SELECT * FROM qrspi_generations
        ORDER BY workflow_id, generation
      `
      const operations = yield* sql<Record<string, unknown>>`
        SELECT * FROM workflow_operations
        ORDER BY logical_operation_id, operation_revision, operation_id
      `
      const migrations = yield* sql<MigrationRow>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `
      const runtimeCounts = yield* Effect.all(
        runtimeTables.map((table) =>
          sql.unsafe<{ readonly count: number }>(
            `SELECT count(*) AS count FROM "${table}"`,
          ),
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
```

The interpolation of table names is safe only because `runtimeTables` is the local compile-time constant inventory. Do not replace it with externally supplied identifiers.

#### 1.4 Assert exact preservation, zero authority, integrity, and retained indexes

**File**: `test/store/migrations.test.ts`

**Changes**: Keep all assertions before the `finally` block. Compare complete state after the first and second current migration runs, then assert each acceptance dimension explicitly enough that a failure identifies the broken contract.

Strip only the two added cursor fields from upgraded Generations and compare every remaining property directly:

```ts
const shippedGenerations = upgraded.afterFirstRun.generations.map(
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
```

Assert the ledger as an exact prefix plus one exact appended row, then prove the rerun did not add or mutate a row:

```ts
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
```

Assert all twelve runtime table counts and integrity:

```ts
expect(upgraded.afterFirstRun.runtimeCounts.flat()).toEqual(
  runtimeTables.map(() => ({ count: 0 })),
)
expect(upgraded.afterSecondRun.runtimeCounts).toEqual(upgraded.afterFirstRun.runtimeCounts)
expect(upgraded.afterFirstRun.foreignKeyViolations).toEqual([])
expect(upgraded.afterSecondRun.foreignKeyViolations).toEqual([])
```

Use `toContainEqual` against the collected inventories for these exact indexes:

- `qrspi_generations_current`: unique, partial, custom index on `workflow_id`;
- `qrspi_generations_definition`: unique, nonpartial, custom index on `workflow_id`, `generation`, `workflow_definition_sha256`;
- `workflow_operations_current`: unique, partial, custom index on `logical_operation_id`;
- `workflow_operations_identity_kind`: unique, nonpartial, custom index on `operation_id`, `kind`.

This keeps the real upgrade proof self-contained without removing the broader existing structural tests.

#### 1.5 Correct only a demonstrated `0011` preservation defect

**File**: `src/store/migrations.ts` (conditional; no planned change)

**Changes**: Run the new focused test before editing production code. If it passes, leave this file untouched. If it fails because `0011_qrspi_stage_runtime_layout` does not satisfy an asserted preservation or integrity contract, retain the failing test and make the smallest correction inside `qrspiStageRuntimeLayout` at `src/store/migrations.ts:644-1178`.

Permitted corrections are limited to the demonstrated reconstruction copy list, foreign-key-safe statement order, or required recreated Generation/WorkflowOperation index definition. Preserve the append-only registration:

```ts
export const runStoreMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    ...migrationsThrough0010,
    "0011_qrspi_stage_runtime_layout": qrspiStageRuntimeLayout,
  }),
})
```

Do not edit any migration through `0010`, add inferred rows, weaken checks or foreign keys, introduce runtime behavior, or add a compensating `0012` conversion for a migration that has not shipped beyond this accepted local change.

### Success Criteria

#### Automated Verification

- [ ] The focused migration suite passes: `bun test test/store/migrations.test.ts`
- [ ] The full repository quality gate passes, including TypeScript, Effect diagnostics, lint, formatting, and tests: `bun run check`
- [ ] The final patch has no whitespace errors: `git diff --check`
- [ ] `git diff -- src/store/migrations.ts` is empty unless the new test first demonstrated a concrete `0011` defect and the diff contains only its smallest correction.

#### Manual Verification

- [ ] Inspect the test and confirm the historical and current database work occurs in two sequential `Effect.runPromise` calls with separately constructed `SqliteClient.layer({ filename })` values over the same filename.
- [ ] Confirm the first layer runs only through `0010`, captures complete ordered `SELECT *` snapshots, and has returned before the current layer is constructed.
- [ ] Confirm the Generation fixture covers both historical formats and current/noncurrent plus terminal/nonterminal values, while the WorkflowOperation fixture covers retry lineage, lease tuples, nullable and populated effect/output fields, terminal metadata, JSON text, hashes, counters, and timestamps.
- [ ] Confirm comparison removes only `current_stage_key` and `current_stage_run_ordinal`, checks both are null, and compares WorkflowOperations without projecting away any column.
- [ ] Confirm the ledger is exact before and after migration, `0011` appears once after rerun, all twelve runtime tables are empty, foreign-key checks are clean, and the four retained indexes are asserted.
- [ ] Confirm `rm(directory, { recursive: true, force: true })` is in `finally` around setup, both layer lifetimes, and every assertion.
- [ ] Confirm no sibling SQL rejection matrix, inferred legacy conversion, runtime allocation, claim, transition, bootstrap, quarantine, trigger, executable claim index, or neighboring lifecycle behavior was added.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation of the manual diff inspection before treating this child implementation as accepted. Do not close the parent migration release gate until both sibling SQL-rejection outcomes also pass.

---

---
task: workflowd-vs3.4.3.1.1-install-the-strict-inactive-shared-runtime-layout
type: plan
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 90a64ecde03d0cf36dafbf3511fcc8179412bae6
---

# Install the Strict Inactive Shared Runtime Layout Implementation Plan

## Overview

Add one append-only `0011_qrspi_stage_runtime_layout` migration that installs the complete inert relational foundation for durable StageRuns and tagged StageRevisions. Preserve a historical runner through migration `0010`, widen the Generation format boundary without inferring cursor values, and prove the complete schema through real-SQLite metadata tests. This delivery intentionally stops before direct invalid-write coverage, file-backed upgrade-preservation fixtures, typed store APIs, or any executable runtime lifecycle.

The accepted Structure keeps this large change atomic because splitting the table family would either publish an incomplete authority graph or require editing an already-applied migration. Implementation and review still proceed in two independently testable phases, with Phase 1 kept unshipped until Phase 2 completes the same migration.

## Current State Analysis

The current migration frontier contains `0001` through `0010`. Migrations `0009` and `0010` are currently registered inline only in `runStoreMigrations`, while `runStoreMigrationsThrough0008` is the sole historical runner (`src/store/migrations.ts:619-640`). Migration `0010` adds `generation_format` with only `legacy | stage_snapshots_v1`, so adding the third literal requires rebuilding `qrspi_generations` rather than changing the shipped migration (`src/store/migrations.ts:502-530`, `src/store/migrations.ts:610-617`).

The current database already supplies all external parents needed by the layout: Generations, executable stage definitions, and physical WorkflowOperations (`src/store/migrations.ts:423-530`, `src/store/migrations.ts:575-608`). The typed contracts fix exact stage coordinates, repository identity, artifact identity, source-set hashing, prepared document output, and implementation commit result shapes (`src/qrspi/contracts/common.ts:39-47`, `src/qrspi/contracts/common.ts:204-215`, `src/qrspi/contracts/common.ts:327-365`, `src/qrspi/contracts/common.ts:388-400`, `src/qrspi/contracts/implementation.ts:59-74`).

The migration test suite already runs the real current migration set against SQLite and inspects migration order, strict-table flags, primary-key positions, DDL checks, and foreign keys (`test/store/migrations.test.ts:24-30`, `test/store/migrations.test.ts:110-154`, `test/store/migrations.test.ts:211-225`, `test/store/migrations.test.ts:554-582`). It does not yet have reusable complete-schema helpers for column nullability, grouped composite foreign keys, or index key order.

### Key Discoveries

- `qrspi_generations` has 15 effective pre-`0011` columns, a composite primary key, three foreign-key relationships, and the `qrspi_generations_current` partial unique index; reconstruction must reproduce all of them exactly (`src/store/migrations.ts:502-530`, `src/store/migrations.ts:610-617`).
- StageRevision ordinals are unique per `(workflow, generation, stage)` across run ordinals, while each StageRun pointer must include the run ordinal and resolve only to a revision from that same run (`docs/qrspi-contract.md:617-624`; accepted Design D1-D2).
- StageRun must bind the Generation's exact workflow-definition hash and one exact `(workflow_definition_sha256, stage_definition_sha256, stage_key)` tuple. Independent hash and key foreign keys would permit a crossed identity, so migration `0011` must add composite unique parent keys and use one composite FK at each boundary.
- Separate document and implementation payload tables are required. A tagged foreign key can prevent the wrong payload kind, but SQL cannot require the child row to exist at common-row insertion time without a trigger; completeness remains a later transaction/decode invariant, consistent with the accepted SQL-versus-Schema boundary.
- Dedicated document and implementation-step ownership tables alone cannot enforce physical-operation uniqueness across both tables. Use one common operation-owner spine keyed by `operation_id`, with tagged one-to-one document and step owner rows. This preserves dedicated owner shapes, gives a global physical-operation key, and adds no trigger.
- Existing migrations already contain unrelated agent payload triggers, so inactivity tests must assert that migration `0011` adds no trigger associated with the new runtime tables rather than asserting that the whole database has no triggers (`src/store/migrations.ts:359-382`).
- The child Structure excludes direct invalid-write cases and the exact file-backed through-`0010` preservation fixture. This plan uses metadata, DDL, emptiness, and migration-order assertions only.

## Desired End State

- `runStoreMigrationsThrough0008` remains unchanged and `runStoreMigrationsThrough0010` is exported from a shared through-`0010` migration record.
- `runStoreMigrations` appends exactly one migration, `0011_qrspi_stage_runtime_layout`; migrations `0001` through `0010` are byte-for-byte unchanged.
- Existing Generation rows retain all values and receive null runtime cursors. `generation_format` admits exactly `legacy`, `stage_snapshots_v1`, and `stage_runtime_v1`.
- A Generation runtime cursor is either entirely null or names a positive StageRun ordinal in the same `(workflow_id, generation)`.
- Strict tables represent StageRuns, common/tagged revisions, ordered implementation steps, immutable artifact/commit/checkpoint references, revision diagnostics, and globally unique physical-operation ownership.
- Every table, column, primary key, foreign key, unique/partial index, accepted literal, JSON root check, hash/Git-SHA shape, positive ordinal, and identity hook is covered by structural metadata tests.
- Applying the migration to an empty current database creates no runtime facts, runtime triggers, executable claim indexes, APIs, or behavior.

## What We're NOT Doing

- Direct-SQL invalid insert/update rejection matrices.
- A file-backed database created through `0010` and reopened through `0011`, including byte-for-byte value-preservation proof.
- Effect Schemas for StageRun or StageRevision aggregates, store read/write methods, semantic hash comparison, or trusted-read diagnostics.
- Runtime bootstrap, allocation, transition, replacement, progression, claim, quarantine, or inferred legacy conversion.
- Review, gate, Provenance, handoff, TargetReconcile, status, readiness, capacity, or external-owner lifecycle records.
- SQL triggers, stage-runtime claim indexes, store composition changes, or changes to runtime files outside `src/store/migrations.ts`.

## Implementation Approach

Follow the repository's existing Effect SQL migration style: one `Effect.gen` migration constant containing explicit `sql` statements, one shared migration record per retained frontier, and real SQLite inspection through the existing store test layer. Write the structural assertions first in each phase, then add the corresponding DDL until those focused assertions pass.

For the cyclic Generation/StageRun relationship, create the parent-key indexes and empty StageRun/StageRevision tables first against the existing through-`0010` Generation table. Then create `qrspi_generations_with_stage_runtime` with the complete final shape, copy all old values while explicitly setting both cursor columns to `NULL`, drop the old Generation table (the newly created runtime tables are still empty), rename the replacement, and recreate both Generation indexes. This ensures `qrspi_stage_runs` exists before any insert into a table whose cursor foreign key targets it and leaves the final circular foreign-key graph valid under `PRAGMA foreign_keys = ON`.

Use these plan-level field decisions wherever the accepted artifacts leave SQL representation open:

- Store `activation_policy_json` as the exact StageActivationPolicy object and `source_set_json` as the hash-bound ordered `ReadonlyArray<{ role, artifact }>` projection used by `sourceSetSha256`; do not persist source content or accepted-pointer data in this common identity column.
- Bound general runtime keys and diagnostic messages with existing repository conventions: stage keys `1..64`, owner/checkpoint keys `1..512`, and reason/message text `1..2000`.
- Flatten `RepositoryReference` into `provider_instance_id`, `repository_id`, and `repository_full_name` on immutable reference tables so repository identity is independently inspectable and constrained.
- Mirror `PositiveVersion`'s SQL-safe range as `BETWEEN 1 AND 1000000` for run, revision, and step ordinals.
- Store prepared result/evidence and changed-path/commit-reference collections as JSON with explicit object/array root checks plus separate lowercase SHA-256 fields where identity is hash-bound.
- Model global operation ownership with `qrspi_stage_operation_owners`, including the physical operation kind and a role/kind consistency check, then use tagged `qrspi_document_stage_revision_operations` and `qrspi_implementation_step_operations` rows for exact owner coordinates.

---

## Phase 1: Establish the Runtime Migration Frontier and Identity Spine

### Overview

Preserve the previous migration frontier, rebuild the Generation boundary, and add StageRun plus common StageRevision identity. The phase proves migration ordering, all preserved and new Generation metadata, same-run revision pointers, current-run uniqueness, owner-crossing uniqueness, strict literals, and inertness. It is a review checkpoint only; do not release or treat the partially assembled migration as complete.

### Changes Required

#### 1.1 Add reusable complete-schema metadata assertions

**File**: `test/store/migrations.test.ts`

**Changes**: Add local types/helpers near `runWithDatabase` for querying columns, grouped foreign keys, indexes, index columns, and persisted DDL. Keep helpers transparent: return raw names, nullability, defaults, PK positions, FK `id/seq`, uniqueness, partialness, and index column order so an omitted schema element cannot be normalized away.

```ts
type ColumnMetadata = {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: string | null
  readonly pk: number
}

const readTableMetadata = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql.unsafe<ColumnMetadata>(
      `SELECT name, type, "notnull", dflt_value, pk
       FROM pragma_table_info(?) ORDER BY cid`,
      [table],
    )
    const foreignKeys = yield* sql.unsafe(
      `SELECT id, seq, "table", "from", "to", on_update, on_delete
       FROM pragma_foreign_key_list(?) ORDER BY id, seq`,
      [table],
    )
    const indexes = yield* sql.unsafe(
      `SELECT name, "unique", partial, origin
       FROM pragma_index_list(?) ORDER BY name`,
      [table],
    )
    const ddl = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
    `
    return { columns, ddl: ddl[0]?.sql, foreignKeys, indexes }
  })
```

Add a small `readIndexColumns(name)` helper using `pragma_index_info(?)`. Do not replace existing behavioral tests or the `rejected` helper; the new helpers serve only the exhaustive structural suite.

#### 1.2 Write failing frontier and Generation structure tests

**File**: `test/store/migrations.test.ts`

**Changes**: Extend the top-level migration-order and strict-table inventory test to expect migration 11 and the Phase 1 tables. Add focused tests that assert:

- `runStoreMigrationsThrough0010` is importable and stops after migration ID 10.
- The full runner ends with exactly `{ migration_id: 11, name: "qrspi_stage_runtime_layout" }`.
- Every original Generation column, type, nullability, default, and PK position remains exact; only `current_stage_key` and `current_stage_run_ordinal` are appended.
- The original workflow, ticket-revision, and definition foreign keys remain exact, and the new four-column cursor FK targets StageRun in the same workflow/Generation.
- `qrspi_generations_current` remains unique, partial, keyed by `workflow_id`, and uses `WHERE is_current = 1`.
- Generation DDL contains the three exact format literals, all-or-none cursor check, positive bounded run ordinal, and no default cursor value.
- An in-memory database migrated through `0010`, seeded with one complete Generation, then advanced with the current runner retains every original value, sets both cursor columns to null, creates no runtime row, and returns no row from `PRAGMA foreign_key_check`.

```ts
expect(result.migrations.at(-1)).toEqual({
  migration_id: 11,
  name: "qrspi_stage_runtime_layout",
})

expect(generation.columns.slice(-2)).toEqual([
  { name: "current_stage_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  {
    name: "current_stage_run_ordinal",
    type: "INTEGER",
    notnull: 0,
    dflt_value: null,
    pk: 0,
  },
])
expect(generation.ddl).toContain(
  "generation_format IN ('legacy', 'stage_snapshots_v1', 'stage_runtime_v1')",
)
expect(generation.ddl).toContain(
  "(current_stage_key IS NULL) = (current_stage_run_ordinal IS NULL)",
)
```

Use a separate in-memory SQLite layer supplied directly to `runStoreMigrationsThrough0010` to prove the retained runner's exact frontier. In the same scoped Effect, seed the required workflow, ticket revision, workflow definition, and Generation rows, invoke `runStoreMigrations`, and compare the Generation before/after projection plus runtime counts and `PRAGMA foreign_key_check`. This is a focused migration reconstruction test, not the excluded file-backed close/reopen and byte-for-byte preservation fixture.

#### 1.3 Preserve the through-0010 runner and append migration 0011

**File**: `src/store/migrations.ts`

**Changes**: Move only migration registration, not migration bodies. Create `migrationsThrough0010`, export the new historical runner, define `qrspiStageRuntimeLayout`, and append it only to the current runner.

```ts
const migrationsThrough0010 = {
  ...migrationsThrough0008,
  "0009_qrspi_stage_definitions": qrspiStageDefinitions,
  "0010_qrspi_generation_format": qrspiGenerationFormat,
}

export const runStoreMigrationsThrough0010 = Migrator.make({})({
  loader: Migrator.fromRecord(migrationsThrough0010),
})

const qrspiStageRuntimeLayout = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Complete Phase 1 and Phase 2 DDL is added here.
})

export const runStoreMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    ...migrationsThrough0010,
    "0011_qrspi_stage_runtime_layout": qrspiStageRuntimeLayout,
  }),
})
```

Keep `migrationsThrough0008` and `runStoreMigrationsThrough0008` unchanged for existing consumers.

#### 1.4 Specify the Generation rebuild with its guarded runtime cursor

**File**: `src/store/migrations.ts`

**Changes**: Define the final Generation reconstruction required inside migration `0011`, preserving old rows while replacing the old embedded format check. The actual statement order in the migration must create the parent-key indexes and empty StageRun/StageRevision targets in step 1.6 before executing this replacement. Recreate every original Generation column and constraint exactly, add the nullable cursor columns and checks, copy all old columns explicitly, and set both new columns to null; do not derive a StageRun from existing operations.

```sql
CREATE TABLE qrspi_generations_with_stage_runtime (
  -- reproduce all columns from the effective through-0010 table
  generation_format TEXT NOT NULL DEFAULT 'legacy' CHECK (
    generation_format IN ('legacy', 'stage_snapshots_v1', 'stage_runtime_v1')
  ),
  current_stage_key TEXT CHECK (
    current_stage_key IS NULL OR length(current_stage_key) BETWEEN 1 AND 64
  ),
  current_stage_run_ordinal INTEGER CHECK (
    current_stage_run_ordinal IS NULL
      OR current_stage_run_ordinal BETWEEN 1 AND 1000000
  ),
  PRIMARY KEY (workflow_id, generation),
  CHECK (
    (current_stage_key IS NULL) = (current_stage_run_ordinal IS NULL)
  ),
  FOREIGN KEY (
    workflow_id, generation, current_stage_key, current_stage_run_ordinal
  ) REFERENCES qrspi_stage_runs (
    workflow_id, generation, stage_key, run_ordinal
  )
) STRICT;

INSERT INTO qrspi_generations_with_stage_runtime (
  -- all original columns in original order, then the cursor columns
  current_stage_key, current_stage_run_ordinal
)
SELECT
  -- all original values in original order
  NULL, NULL
FROM qrspi_generations;

DROP TABLE qrspi_generations;
ALTER TABLE qrspi_generations_with_stage_runtime RENAME TO qrspi_generations;
CREATE UNIQUE INDEX qrspi_generations_current
ON qrspi_generations (workflow_id) WHERE is_current = 1;
CREATE UNIQUE INDEX qrspi_generations_definition
ON qrspi_generations (workflow_id, generation, workflow_definition_sha256);
```

Before creating StageRun, create `qrspi_generations_definition` on the through-`0010` table so its composite FK has a valid parent key. Dropping the old table also drops that index; recreate it immediately after renaming the replacement. Verify the complete sequence under the existing migration transaction with `PRAGMA foreign_keys = ON` and finish the focused reconstruction test with `PRAGMA foreign_key_check`. Do not disable foreign-key enforcement or weaken the final graph.

#### 1.5 Write failing StageRun and common-revision metadata tests

**File**: `test/store/migrations.test.ts`

**Changes**: Add table-driven exact expected-column arrays for `qrspi_stage_runs` and `qrspi_stage_revisions`, then assert:

- Both tables are `STRICT`.
- StageRun PK order is workflow, Generation, stage, run; StageRevision PK order is workflow, Generation, stage, revision.
- Run/revision/step-style ordinals use `BETWEEN 1 AND 1000000`.
- StageRun references the same Generation plus its exact workflow-definition hash through one three-column FK, and references one exact workflow-definition/stage-definition/stage-key tuple through one three-column FK.
- Each pending/published/accepted pointer includes workflow, Generation, stage, run, and revision and targets the same-run supporting key.
- Common revisions reference an exact run and expose unique keys for same-run pointers and tagged payload FKs.
- `source_set_json` is documented and structurally checked as an array containing the hash-bound ordered `{ role, artifact }` identity projection; semantic element decoding and hash recomputation remain assigned to the later typed-store child.
- `qrspi_stage_runs_current` is unique and partial on `(workflow_id, generation, stage_key) WHERE is_current = 1`.
- `owner_crossing_key` is non-null, bounded, and globally unique.
- JSON root and lowercase SHA-256 checks are explicit.
- Run states, revision kinds, and revision states equal the accepted literal sets without extras.

```ts
expect(stageRunPrimaryKey).toEqual([
  "workflow_id",
  "generation",
  "stage_key",
  "run_ordinal",
])
expect(stageRevision.ddl).toContain(
  "kind IN ('document', 'implementation')",
)
expect(stageRevision.ddl).toContain(
  "state IN ('producing', 'publishing', 'reviewing', 'waiting_human', " +
    "'accepted', 'abandoned', 'failed', 'superseded')",
)
```

#### 1.6 Create StageRun and common StageRevision, then rebuild Generation

**File**: `src/store/migrations.ts`

**Changes**: Add the exact composite unique parent indexes, then the two identity-spine tables to migration `0011`. After both target tables exist, execute the Generation replacement from step 1.4. Use this relationship shape:

```sql
CREATE TABLE qrspi_stage_runs (
  workflow_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64),
  run_ordinal INTEGER NOT NULL CHECK (run_ordinal BETWEEN 1 AND 1000000),
  workflow_definition_sha256 TEXT NOT NULL CHECK (
    length(workflow_definition_sha256) = 64
      AND workflow_definition_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  stage_definition_sha256 TEXT NOT NULL CHECK (
    length(stage_definition_sha256) = 64
      AND stage_definition_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN (
    'blocked', 'active', 'waiting_review', 'waiting_human', 'waiting_ticket',
    'succeeded', 'skipped', 'rejected', 'failed', 'cancelled', 'superseded',
    'data_error'
  )),
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  activation_policy_json TEXT NOT NULL CHECK (
    json_valid(activation_policy_json) = 1
      AND json_type(activation_policy_json, '$') = 'object'
  ),
  skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 2000),
  pending_revision INTEGER CHECK (pending_revision BETWEEN 1 AND 1000000),
  published_revision INTEGER CHECK (published_revision BETWEEN 1 AND 1000000),
  accepted_revision INTEGER CHECK (accepted_revision BETWEEN 1 AND 1000000),
  terminal_reason TEXT CHECK (
    terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 2000
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, generation, stage_key, run_ordinal),
  FOREIGN KEY (workflow_id, generation, workflow_definition_sha256)
    REFERENCES qrspi_generations (
      workflow_id, generation, workflow_definition_sha256
    ),
  FOREIGN KEY (
    workflow_definition_sha256, stage_definition_sha256, stage_key
  )
    REFERENCES qrspi_stage_definitions (
      workflow_definition_sha256, stage_definition_sha256, stage_key
    ),
  -- repeat the same-run composite FK for pending/published/accepted_revision
) STRICT;

CREATE TABLE qrspi_stage_revisions (
  workflow_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64),
  stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000),
  run_ordinal INTEGER NOT NULL CHECK (run_ordinal BETWEEN 1 AND 1000000),
  kind TEXT NOT NULL CHECK (kind IN ('document', 'implementation')),
  state TEXT NOT NULL CHECK (state IN (
    'producing', 'publishing', 'reviewing', 'waiting_human', 'accepted',
    'abandoned', 'failed', 'superseded'
  )),
  owner_crossing_key TEXT NOT NULL UNIQUE
    CHECK (length(owner_crossing_key) BETWEEN 1 AND 512),
  source_set_json TEXT NOT NULL CHECK (
    json_valid(source_set_json) = 1 AND json_type(source_set_json, '$') = 'array'
  ),
  source_set_sha256 TEXT NOT NULL CHECK (
    length(source_set_sha256) = 64
      AND source_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, generation, stage_key, stage_revision),
  UNIQUE (workflow_id, generation, stage_key, run_ordinal, stage_revision),
  UNIQUE (workflow_id, generation, stage_key, stage_revision, kind),
  FOREIGN KEY (workflow_id, generation, stage_key, run_ordinal)
    REFERENCES qrspi_stage_runs (workflow_id, generation, stage_key, run_ordinal)
) STRICT;

CREATE UNIQUE INDEX qrspi_stage_runs_current
ON qrspi_stage_runs (workflow_id, generation, stage_key)
WHERE is_current = 1;
```

Before these tables, create `qrspi_generations_definition` on `(workflow_id, generation, workflow_definition_sha256)` and `qrspi_stage_definitions_identity` on `(workflow_definition_sha256, stage_definition_sha256, stage_key)`. Recreate the Generation index after replacement; retain the stage-definition index. Add all three same-run pointer FKs explicitly. The exact implementation order is parent indexes, StageRun, StageRevision, Generation replacement, then current-run index. Do not add a trigger requiring one tagged payload or any claim-oriented index.

#### 1.7 Prove Phase 1 inertness and review the authority spine

**File**: `test/store/migrations.test.ts`

**Changes**: Add one focused test that queries StageRun and StageRevision counts after normal migration and verifies both are zero. Query `sqlite_master` to prove no trigger references `qrspi_stage_runs`, `qrspi_stage_revisions`, or the Generation cursor and no new index name or SQL contains `claimable` for a stage-runtime table.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Compare the final Phase 1 DDL and metadata expectations with accepted Design D1-D4: historical runners are intact, old Generation shape is faithfully reproduced, no cursor is inferred, and every revision pointer includes the exact run identity.
- [ ] Confirm the Phase 1 diff changes only `src/store/migrations.ts` and `test/store/migrations.test.ts`, leaves the bodies of migrations `0001` through `0010` unchanged, and contains no runtime API, trigger, or claim index.

**Implementation Note**: After completing Phase 1 and all automated verification passes, pause for human confirmation of the migration-frontier and authority-spine review before proceeding. Phase 1 is not independently releasable; keep the branch unshipped until Phase 2 completes the same `0011` migration.

---

## Phase 2: Complete the Tagged Runtime Layout and Structural Inventory

### Overview

Complete migration `0011` with the document and implementation payload variants, ordered implementation steps, immutable references, bounded diagnostics, and globally unique operation ownership. Extend the metadata suite into a one-to-one DDL inventory and finish with full repository checks plus a negative-scope diff review.

### Changes Required

#### 2.1 Write failing tagged-payload and implementation-step metadata tests

**File**: `test/store/migrations.test.ts`

**Changes**: Add exact expected-column and FK arrays for:

- `qrspi_document_stage_revisions`
- `qrspi_implementation_stage_revisions`
- `qrspi_implementation_steps`

Assert one-to-one primary keys, fixed `kind` literals, tagged composite FKs to common revisions, implementation-step ownership by the implementation variant, positive ordered-position identity, JSON object checks, lowercase SHA-256 checks, and nullable prepared output/evidence pairs guarded all-or-none. Metadata proves positive unique positions; contiguous sequence validation remains a later strict-read/transaction invariant because this migration deliberately adds no trigger.

```ts
expect(documentForeignKeys).toContainEqual({
  from: ["workflow_id", "generation", "stage_key", "stage_revision", "kind"],
  table: "qrspi_stage_revisions",
  to: ["workflow_id", "generation", "stage_key", "stage_revision", "kind"],
})
expect(document.ddl).toContain("kind = 'document'")
expect(implementation.ddl).toContain("kind = 'implementation'")
expect(step.ddl).toContain("position BETWEEN 1 AND 1000000")
```

#### 2.2 Add strict tagged revision payloads and ordered steps

**File**: `src/store/migrations.ts`

**Changes**: Add separate payload tables with a fixed tag column participating in the FK, then add implementation steps. Use the following common shapes:

```sql
CREATE TABLE qrspi_document_stage_revisions (
  workflow_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64),
  stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000),
  kind TEXT NOT NULL DEFAULT 'document' CHECK (kind = 'document'),
  prepared_result_json TEXT CHECK (
    prepared_result_json IS NULL OR (
      json_valid(prepared_result_json) = 1
        AND json_type(prepared_result_json, '$') = 'object'
    )
  ),
  prepared_result_sha256 TEXT CHECK (
    prepared_result_sha256 IS NULL OR (
      length(prepared_result_sha256) = 64
        AND prepared_result_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, generation, stage_key, stage_revision),
  CHECK ((prepared_result_json IS NULL) = (prepared_result_sha256 IS NULL)),
  FOREIGN KEY (workflow_id, generation, stage_key, stage_revision, kind)
    REFERENCES qrspi_stage_revisions (
      workflow_id, generation, stage_key, stage_revision, kind
    )
) STRICT;
```

Define `qrspi_implementation_stage_revisions` with the same four non-null identity columns and primary key, `kind TEXT NOT NULL DEFAULT 'implementation' CHECK (kind = 'implementation')`, nullable `prepared_delivery_evidence_json` constrained to an object, nullable lowercase `prepared_delivery_evidence_sha256`, non-null timestamps, an all-or-none evidence/hash check, and the five-column tagged FK to `qrspi_stage_revisions`.

Define `qrspi_implementation_steps` with these exact columns and constraints:

```sql
CREATE TABLE qrspi_implementation_steps (
  workflow_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64),
  stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 1000000),
  prepared_result_json TEXT CHECK (
    prepared_result_json IS NULL OR (
      json_valid(prepared_result_json) = 1
        AND json_type(prepared_result_json, '$') = 'object'
    )
  ),
  prepared_result_sha256 TEXT CHECK (
    prepared_result_sha256 IS NULL OR (
      length(prepared_result_sha256) = 64
        AND prepared_result_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  final INTEGER CHECK (final IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, generation, stage_key, stage_revision, position),
  CHECK (
    (prepared_result_json IS NULL AND prepared_result_sha256 IS NULL AND final IS NULL)
      OR (prepared_result_json IS NOT NULL
        AND prepared_result_sha256 IS NOT NULL AND final IS NOT NULL)
  ),
  FOREIGN KEY (workflow_id, generation, stage_key, stage_revision)
    REFERENCES qrspi_implementation_stage_revisions (
      workflow_id, generation, stage_key, stage_revision
    )
) STRICT;
```

The PK enforces one row per position and deterministic ordering; later aggregate decode rejects gaps or a non-final step after a final one.

Do not add review-subject, review-round, session, or lifecycle columns; those belong to neighboring capabilities or later typed aggregates.

#### 2.3 Write failing immutable-reference metadata tests

**File**: `test/store/migrations.test.ts`

**Changes**: Add exact inventory tests for:

- `qrspi_artifact_references`
- `qrspi_implementation_commit_references`
- `qrspi_implementation_checkpoints`

For each table assert the exact owner PK/FK, flattened repository identity, Git SHA checks, JSON array roots, lowercase content/evidence hashes, path/media bounds, checkpoint identity uniqueness, and one immutable record per exact owner. Verify that artifact references belong only to document revisions, commit references only to exact implementation steps, and checkpoints only to implementation revisions.

#### 2.4 Add immutable artifact, commit, and checkpoint references

**File**: `src/store/migrations.ts`

**Changes**: Add three strict child tables.

`qrspi_artifact_references` exact shape (all fields non-null unless stated otherwise):

- Owner: `workflow_id`, `generation`, `stage_key`, `stage_revision` as PK/FK to document revision.
- Repository: `provider_instance_id` and `repository_id` bounded `1..128`; `repository_full_name` bounded `3..256` and containing `/`.
- Git/content: `commit_sha`, `path`, `blob_sha`, `content_sha256`, `media_type`.
- Checks: lowercase 40/64 Git SHAs, lowercase 64 SHA-256, path `1..512`, media type `1..128`, and non-null `created_at`/`updated_at`.

`qrspi_implementation_commit_references` exact shape (all fields non-null):

- Owner: implementation step identity as PK/FK.
- Repository identity as above.
- `commit_sha`, `expected_parent_sha`, `changed_paths_json` as a non-empty JSON array, `changed_paths_sha256`, `created_at`, and `updated_at`.
- Keep the owner row's `final` classification on `qrspi_implementation_steps`; do not duplicate it here.

`qrspi_implementation_checkpoints` exact shape (all fields non-null):

- Owner: implementation revision identity as PK/FK.
- `checkpoint_id TEXT NOT NULL UNIQUE CHECK (length(checkpoint_id) BETWEEN 1 AND 512)`.
- Flattened repository identity, `base_sha`, `final_sha`, `commit_references_json` non-empty array, `commit_references_sha256`, `changed_paths_json` non-empty array, `changed_paths_sha256`, `prepared_delivery_evidence_sha256`, and timestamps.

Representative checks:

```sql
commit_sha TEXT NOT NULL CHECK (
  length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^0-9a-f]*'
),
changed_paths_json TEXT NOT NULL CHECK (
  json_valid(changed_paths_json) = 1
    AND json_type(changed_paths_json, '$') = 'array'
    AND json_array_length(changed_paths_json) > 0
),
changed_paths_sha256 TEXT NOT NULL CHECK (
  length(changed_paths_sha256) = 64
    AND changed_paths_sha256 NOT GLOB '*[^0-9a-f]*'
)
```

The later store boundary will verify canonical hashes, ordered child equality, path grammar, and cross-column repository identity. This migration enforces local type, root shape, key, and bounded identity only.

#### 2.5 Write failing diagnostic and operation-ownership metadata tests

**File**: `test/store/migrations.test.ts`

**Changes**: Add exact inventory tests for:

- `qrspi_stage_revision_diagnostics`
- `qrspi_stage_operation_owners`
- `qrspi_document_stage_revision_operations`
- `qrspi_implementation_step_operations`

Assert one diagnostic per readable common revision, exact reason literals, bounded observed values/message, nullable object/hash details, and the common-revision FK. For ownership, assert:

- `(operation_id, operation_kind)` is the global common-owner FK to the physical `workflow_operations` row, supported by a unique parent index.
- `owner_kind` is exactly `document_revision | implementation_step` and `operation_role` is exactly `produce | publish`.
- `operation_role = 'produce'` requires `operation_kind = 'StageProduce'`, while `operation_role = 'publish'` requires `operation_kind = 'ArtifactPublish'`.
- Each tagged owner row references both the common owner tag/role and its exact document or step owner.
- One owner role exists at most once per document revision or implementation step.
- The common `qrspi_stage_operation_owners_role` index is keyed `(operation_role, operation_id)` and provides the publication-operation lookup hook.
- No runtime trigger is used to enforce ownership.

#### 2.6 Add bounded revision diagnostics

**File**: `src/store/migrations.ts`

**Changes**: Add one diagnostic per common revision. Treat `missing` as a missing tagged/reference child beneath a readable common revision, so the diagnostic retains a strict FK to that common revision.

```sql
CREATE TABLE qrspi_stage_revision_diagnostics (
  workflow_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64),
  stage_revision INTEGER NOT NULL CHECK (stage_revision BETWEEN 1 AND 1000000),
  observed_kind TEXT CHECK (observed_kind IS NULL OR length(observed_kind) BETWEEN 1 AND 64),
  observed_state TEXT CHECK (observed_state IS NULL OR length(observed_state) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK (reason IN (
    'malformed', 'missing', 'duplicate', 'reordered', 'hash_mismatch',
    'identity_mismatch'
  )),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  expected_json TEXT CHECK (
    expected_json IS NULL OR (
      json_valid(expected_json) = 1 AND json_type(expected_json, '$') = 'object'
    )
  ),
  actual_json TEXT CHECK (
    actual_json IS NULL OR (
      json_valid(actual_json) = 1 AND json_type(actual_json, '$') = 'object'
    )
  ),
  expected_sha256 TEXT CHECK (
    expected_sha256 IS NULL OR (
      length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  actual_sha256 TEXT CHECK (
    actual_sha256 IS NULL OR (
      length(actual_sha256) = 64 AND actual_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, generation, stage_key, stage_revision),
  FOREIGN KEY (workflow_id, generation, stage_key, stage_revision)
    REFERENCES qrspi_stage_revisions (
      workflow_id, generation, stage_key, stage_revision
    )
) STRICT;
```

Do not add quarantine transitions or widen the accepted StageRevision state set.

#### 2.7 Add globally unique tagged operation ownership

**File**: `src/store/migrations.ts`

**Changes**: Add one common physical-operation owner row and two tagged owner variants.

```sql
CREATE TABLE qrspi_stage_operation_owners (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN ('StageProduce', 'ArtifactPublish')
  ),
  owner_kind TEXT NOT NULL CHECK (
    owner_kind IN ('document_revision', 'implementation_step')
  ),
  operation_role TEXT NOT NULL CHECK (operation_role IN ('produce', 'publish')),
  created_at TEXT NOT NULL,
  UNIQUE (operation_id, owner_kind, operation_role),
  CHECK (
    (operation_role = 'produce' AND operation_kind = 'StageProduce')
      OR (operation_role = 'publish' AND operation_kind = 'ArtifactPublish')
  ),
  FOREIGN KEY (operation_id, operation_kind)
    REFERENCES workflow_operations (operation_id, kind)
) STRICT;

CREATE INDEX qrspi_stage_operation_owners_role
ON qrspi_stage_operation_owners (operation_role, operation_id);
```

First create `workflow_operations_identity_kind` as a unique index on `(operation_id, kind)` so the common composite FK has an exact parent key. Create `qrspi_document_stage_revision_operations` with document revision coordinates, fixed `owner_kind = 'document_revision'`, `operation_role`, globally unique `operation_id`, timestamps, and:

```sql
PRIMARY KEY (workflow_id, generation, stage_key, stage_revision, operation_role),
UNIQUE (operation_id),
FOREIGN KEY (workflow_id, generation, stage_key, stage_revision)
  REFERENCES qrspi_document_stage_revisions (...),
FOREIGN KEY (operation_id, owner_kind, operation_role)
  REFERENCES qrspi_stage_operation_owners (operation_id, owner_kind, operation_role)
```

Create `qrspi_implementation_step_operations` analogously, adding `position` to its owner identity and referencing `qrspi_implementation_steps`. The common PK prevents a physical WorkflowOperation from crossing between document and step ownership; each tagged PK prevents duplicate producer or publication roles for one owner. The `publish` row is the accepted publication-operation identity hook. Do not add triggers requiring a common owner to have a tagged child; later atomic store writes and strict reads enforce that coordinated completeness.

#### 2.8 Finish the exhaustive strict-table, emptiness, and inactivity inventory

**File**: `test/store/migrations.test.ts`

**Changes**: Replace the temporary Phase 1 table count with the complete final list and assert every runtime table has `strict = 1`. Add a table-driven count query proving all new tables are empty immediately after migration. Query `sqlite_master` to assert:

- No trigger SQL references any new runtime table.
- No new runtime index name or SQL contains `claim`, `claimable`, `lease`, or `run_at`.
- Every expected named explicit index exists with exact uniqueness, partialness, columns, and predicate.
- The owner-crossing key and common physical-operation PK are both globally unique authority seams.
- A `publish` ownership row is structurally distinguishable through the exact role literal and role index.

Keep every expected table/column/FK/index in one explicit inventory object so schema additions or omissions require a deliberate test update.

```ts
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

const counts = yield* Effect.all(
  runtimeTables.map((table) =>
    sql.unsafe<{ readonly count: number }>(
      `SELECT count(*) AS count FROM "${table}"`,
    ),
  ),
)
expect(counts.flat()).toEqual(runtimeTables.map(() => ({ count: 0 })))
```

Use only the fixed local `runtimeTables` constants in dynamic SQL; do not accept external identifiers.

#### 2.9 Perform final append-only and negative-scope review

**Files**: `src/store/migrations.ts`, `test/store/migrations.test.ts`

**Changes**: Format and review the final diff in these logical segments: frontier/Generation, run/revision spine, tagged payload/steps, immutable references/diagnostics, operation ownership, then metadata/inactivity proof. Confirm no production file outside the migration changed and no test crossed into the next child's direct-write or file-backed boundary.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Reconcile every accepted table family and authority edge against the final metadata inventory: Generation cursor, same-run pointers, tagged payloads, ordered steps, immutable references, diagnostics, owner-crossing identity, publication-operation identity, and globally unique physical-operation ownership.
- [ ] Inspect `git diff -- src/store/migrations.ts` and confirm migrations `0001` through `0010` are unchanged, exactly one `0011` migration is appended, and no old row receives inferred cursor or runtime facts.
- [ ] Inspect `git diff --name-only` and confirm production changes are limited to `src/store/migrations.ts`; verify no trigger, executable claim index, store method, runtime API, bootstrap, transition, quarantine action, neighboring lifecycle, direct-write matrix, or file-backed upgrade fixture was added.

**Implementation Note**: After Phase 2 and all automated verification pass, pause for final human confirmation. Do not close the Bead, push, create or update a pull request, or run Dolt remote sync as part of implementation handoff.

## Authority and Traceability

- Accepted ancestor Design: `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md`, revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`.
- Accepted child Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.1-install-the-strict-inactive-shared-runtime-layout/01-structure-outline-inactive-runtime-layout.md`.
- Accepted child scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.1-install-the-strict-inactive-shared-runtime-layout/04-structure-scope-review-r1.md`, verdict `KeepLarge`.
- This plan adopts the accepted local content-addressed compatibility authority limitation. It does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

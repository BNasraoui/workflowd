---
task: workflowd-vs3.4.3.1.2.1-prove-runtime-identity-spine-sql-rejection
type: plan
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: ae7e7ff9c423ee179db5e5b798502823786a3042
---

# Prove Runtime Identity-Spine SQL Rejection Implementation Plan

## Overview

Add the reusable real-SQLite valid-runtime fixture and deterministic unchanged-graph assertion owned by Bead `workflowd-vs3.4.3.1.2.1`, then use them to prove the SQL-local identity spine rejects every allocated format, tag, ordinal, cursor, currentness, owner-crossing, and same-run pointer contradiction. Every case will start from a newly migrated and seeded database, attempt exactly one direct SQL statement, require SQLite rejection, compare the complete parent/runtime graph before and after, and require an empty `PRAGMA foreign_key_check` result.

This is migration verification for the inactive `0011_qrspi_stage_runtime_layout`, not runtime behavior. The following tagged-invariant child will consume and extend the shared fixture and snapshot foundation; the independent upgrade child owns file-backed `0010` preservation. Passing this plan contributes one result to the atomic parent migration gate but does not release that gate.

## Current State Analysis

Migration `0011_qrspi_stage_runtime_layout` is already registered after the retained through-`0010` runner and creates the Generation cursor, historical StageRun and common StageRevision identities, all tagged/reference/ownership tables, and their SQL-local checks (`src/store/migrations.ts:634-644`, `src/store/migrations.ts:1180-1185`). The migration test suite already proves the exact table, column, foreign-key, index, strictness, and DDL metadata, and it proves an upgrade creates no inferred runtime facts (`test/store/migrations.test.ts:665-679`, `test/store/migrations.test.ts:769-1989`). It does not yet create a valid populated runtime graph or execute behavioral invalid-write cases against that graph.

### Key Discoveries

- The test harness creates a fresh in-memory SQLite layer and runs the current migrations for each `runWithDatabase` invocation, so one invocation per matrix case gives deterministic isolation without cleanup code (`test/store/harness.ts:107-112`, `test/store/migrations.test.ts:31-37`).
- The existing `rejected` helper converts any Effect failure into a boolean and can be composed inside the new unchanged-state assertion (`test/store/migrations.test.ts:36-37`).
- StageRun rows must be inserted with null revision pointers because they reference common revisions, while common revisions themselves reference StageRuns. The pointers can be installed only after both sides exist (`src/store/migrations.ts:658-758`).
- A Generation must first be inserted with a null cursor, because StageRuns reference the Generation while the reconstructed Generation table references a StageRun cursor. The valid cursor is installed after run insertion (`src/store/migrations.ts:761-803`).
- SQL already appears to allocate every identity-spine control: bounded run and revision ordinals and literal checks (`src/store/migrations.ts:658-758`), paired and same-Generation cursor checks (`src/store/migrations.ts:782-802`), one-current-run uniqueness (`src/store/migrations.ts:832-835`), global owner-crossing uniqueness (`src/store/migrations.ts:737-739`), and five-column same-run revision pointers (`src/store/migrations.ts:708-722`). Production changes therefore remain contingency-only.
- The accepted Design assigns local shapes, literals, keys, foreign keys, and one-current-row constraints to SQLite while reserving semantic hashes, transition ordering, monotonic allocation, and coordinated pointer movement for typed store transactions; it explicitly prohibits progression triggers (`.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md:83-87`, `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md:168-172`).
- The accepted child Structure requires two independently testable phases and explicitly excludes cursor-to-currentness agreement, pointer-to-lifecycle agreement, monotonic/contiguous revision allocation, and general update/delete prohibition (`01-structure-outline-runtime-identity-spine.md:27-30`, `01-structure-outline-runtime-identity-spine.md:59-69`).

## Desired End State

- `test/store/migrations.test.ts` contains one deterministic helper that seeds the parent spine, two Generations, multiple stage definitions, historical and current StageRuns, document and implementation common revisions, valid tagged children, physical WorkflowOperations, valid same-run pointers, and a valid Generation cursor while keeping `PRAGMA foreign_keys = ON`.
- One snapshot helper reads the six fixture-owned parent tables plus all twelve runtime tables using explicit stable key order. Empty runtime tables remain represented so the following child can populate them without changing the assertion contract.
- One shared assertion snapshots the graph, requires one supplied statement to fail, snapshots again, compares exact graph equality, and requires both enabled foreign keys and an empty `PRAGMA foreign_key_check` result.
- Fresh-fixture cases reject every allocated local format/tag/currentness/ordinal contradiction and every allocated relational cursor/current-run/owner-key/same-run-pointer contradiction.
- Rejected writes leave historical and current seeded rows unchanged. This is the ticket's append-only-history evidence; it does not claim SQL forbids otherwise-valid updates or deletes.
- `src/store/migrations.ts` remains unchanged unless a case demonstrates that an allocated invariant is accepted. Any demonstrated correction is the smallest edit to the existing `0011` check, key, foreign key, or index and is covered by the full migration-11 metadata and rejection suites.

## What We're NOT Doing

- Tagged payload/reference JSON, hash, nullable pair/triad, wrong-parent variant, operation role/kind, duplicate owner-role, or physical-operation ownership rejection cases; Bead `workflowd-vs3.4.3.1.2.2` owns them.
- File-backed `0010` to `0011` upgrade preservation, migration-ledger advancement, null-cursor upgrade proof, or zero inferred runtime rows; the independent upgrade child owns them.
- Typed StageRun or StageRevision Schemas, aggregate decode, semantic hash recomputation, store create/read methods, stale outcomes, or transaction APIs.
- Runtime allocation, monotonic replacement, transition, claim, progression, bootstrap, quarantine, legacy conversion, or neighboring lifecycle behavior.
- SQL triggers, cursor-to-`is_current` agreement, pointer-to-revision-state agreement, contiguous revision allocation, or general update/delete prohibition.
- Parent migration-gate completion or release. All sibling outcomes must pass together.

## Implementation Approach

Keep all planned work in the existing migration-11 `describe` block. Build the fixture in foreign-key order and resolve the two insertion cycles by initially leaving Generation cursor and StageRun revision pointers null. Seed deliberately separated identities: two Generations for cross-Generation cursor rejection, two stages for both document and implementation tagged children, historical and current runs for same-run pointer rejection, and several revisions in the current run so all three valid pointers are non-null before each attempted contradiction.

Represent the snapshot inventory as an explicit table-to-order mapping rather than deriving order from SQLite metadata. This makes exact equality deterministic and makes ownership of every parent and runtime table reviewable. Represent invalid cases as named statement factories; each Bun test will create a new database, seed once, and pass one statement to the shared assertion. Do not batch invalid statements in `Effect.all`, because a single fixture must never observe state left by another attempted case.

---

## Phase 1: Establish the Reusable Rejection Harness and Local Guards

### Overview

Create the complete deterministic identity-spine fixture, all-table snapshot contract, and shared reject/unchanged/foreign-key assertion. Prove the contract with local Generation, StageRun, and common StageRevision literal and ordinal checks before adding multi-row relational contradictions.

### Changes Required

#### 1.1 Add deterministic runtime identities and seed the valid graph

**File**: `test/store/migrations.test.ts`

**Changes**: In the migration-11 `describe` block after `runtimeTables` (`test/store/migrations.test.ts:665-679`), add bounded constants for workflow, ticket, workflow definition, document and implementation stage definitions, hashes, timestamps, and operation IDs. Add `seedValidRuntimeIdentitySpine`, which performs the following ordered writes with foreign keys enabled:

1. Insert one workflow, one ticket revision, one workflow definition, and document/implementation stage definitions.
2. Insert Generation 1 as the current `stage_runtime_v1` Generation and Generation 2 as noncurrent, both with null cursor fields.
3. Insert deterministic `StageProduce` and `ArtifactPublish` physical WorkflowOperations needed by the complete graph and by the following child, without claiming operation-ownership rejection coverage here.
4. Insert a historical document run and a current document run in Generation 1, an implementation run in Generation 1, and a document run in Generation 2 whose ordinal does not exist for that stage in Generation 1.
5. Insert common document revisions across the historical and current document runs plus one common implementation revision. Use globally distinct owner-crossing keys and valid source-set arrays/hashes.
6. Insert matching one-to-one document and implementation tagged rows. Keep tagged payloads locally valid; their invalid-shape matrix belongs to the next child.
7. Update the current document run with valid, non-null pending, published, and accepted pointers to revisions belonging to that same run.
8. Update Generation 1 with a valid cursor to the current document run.

Use separate revision numbers within one `(workflow_id, generation, stage_key)` because the common revision primary key does not include `run_ordinal`. A concrete shape is:

```ts
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
} as const

const seedValidRuntimeIdentitySpine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA foreign_keys = ON`

  // Insert workflow, ticket, workflow definition, stage definitions,
  // both Generations, and physical WorkflowOperations first.
  // Generations initially retain NULL cursor fields.

  yield* sql`
    INSERT INTO qrspi_stage_runs (
      workflow_id, generation, stage_key, run_ordinal,
      workflow_definition_sha256, stage_definition_sha256,
      state, is_current, activation_policy_json,
      pending_revision, published_revision, accepted_revision,
      created_at, updated_at
    ) VALUES
      (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 1,
       ${runtimeFixture.workflowDefinitionSha256},
       ${runtimeFixture.documentStageDefinitionSha256},
       'succeeded', 0, '{}', NULL, NULL, NULL, ${timestamp}, ${timestamp}),
      (${runtimeFixture.workflowId}, 1, ${runtimeFixture.documentStageKey}, 2,
       ${runtimeFixture.workflowDefinitionSha256},
       ${runtimeFixture.documentStageDefinitionSha256},
       'active', 1, '{}', NULL, NULL, NULL, ${timestamp}, ${timestamp})
  `

  // Insert common revisions and matching valid tagged children here.

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
```

The implementation should keep SQL explicit rather than introducing a general fixture builder. The deterministic row inventory is acceptance-bearing test data and is intended for direct extension by the tagged-invariant child.

#### 1.2 Snapshot every fixture-owned parent and runtime table

**File**: `test/store/migrations.test.ts`

**Changes**: Add an explicit stable-order inventory and `readRuntimeGraph`. Include these six parent tables:

- `qrspi_workflows` ordered by `workflow_id`
- `qrspi_ticket_revisions` ordered by `workflow_id, ticket_revision_sha256`
- `qrspi_workflow_definitions` ordered by `definition_sha256`
- `qrspi_stage_definitions` ordered by `workflow_definition_sha256, stage_definition_sha256`
- `qrspi_generations` ordered by `workflow_id, generation`
- `workflow_operations` ordered by `logical_operation_id, operation_revision, operation_id`

Include all twelve `runtimeTables`, even when a table is empty in this child, with explicit primary-key order. This preserves one snapshot contract when the following child adds references, diagnostics, and ownership rows.

```ts
const runtimeGraphOrder = {
  qrspi_workflows: "workflow_id",
  qrspi_ticket_revisions: "workflow_id, ticket_revision_sha256",
  qrspi_workflow_definitions: "definition_sha256",
  qrspi_stage_definitions:
    "workflow_definition_sha256, stage_definition_sha256",
  qrspi_generations: "workflow_id, generation",
  workflow_operations:
    "logical_operation_id, operation_revision, operation_id",
  qrspi_stage_runs: "workflow_id, generation, stage_key, run_ordinal",
  qrspi_stage_revisions:
    "workflow_id, generation, stage_key, stage_revision",
  qrspi_document_stage_revisions:
    "workflow_id, generation, stage_key, stage_revision",
  qrspi_implementation_stage_revisions:
    "workflow_id, generation, stage_key, stage_revision",
  qrspi_implementation_steps:
    "workflow_id, generation, stage_key, stage_revision, position",
  qrspi_artifact_references:
    "workflow_id, generation, stage_key, stage_revision",
  qrspi_implementation_commit_references:
    "workflow_id, generation, stage_key, stage_revision, position",
  qrspi_implementation_checkpoints:
    "workflow_id, generation, stage_key, stage_revision",
  qrspi_stage_revision_diagnostics:
    "workflow_id, generation, stage_key, stage_revision",
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
      sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM "${table}" ORDER BY ${orderBy}`,
      ).pipe(Effect.map((rows) => [table, rows] as const)),
    ),
    { concurrency: 1 },
  )
  return Object.fromEntries(entries)
})
```

The table and ordering fragments are static test constants, never external input. Keep `workflow_operation_gates` out of the inventory unless the fixture actually starts seeding gate rows; no gate is required for this identity-spine proof.

#### 1.3 Add the shared rejection and unchanged-state assertion

**File**: `test/store/migrations.test.ts`

**Changes**: Add `expectIdentitySpineRejection`, accepting exactly one SQL Effect. It must capture the complete graph before execution, require `rejected(statement)` to return true, compare the complete graph afterward, and verify both `PRAGMA foreign_keys` and `PRAGMA foreign_key_check`. This proves statement atomicity and protects seeded historical rows without adding an explicit transaction around the invalid statement.

```ts
const expectIdentitySpineRejection = <A, E, R>(
  statement: Effect.Effect<A, E, R>,
) =>
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
```

If TypeScript cannot retain the statement environment through the generic helper, constrain it to the `SqlClient.SqlClient` service used by all callers rather than weakening the test to `unknown` or using a cast.

#### 1.4 Add the local format, tag, currentness-value, and ordinal matrix

**File**: `test/store/migrations.test.ts`

**Changes**: Add named table-driven cases after the existing structural migration-11 tests. Each case must call `runWithDatabase` separately, run `seedValidRuntimeIdentitySpine`, construct one SQL statement, and run `expectIdentitySpineRejection`. Cover exactly:

- unsupported Generation `generation_format`
- unsupported StageRun `state`
- invalid StageRun `is_current` below and above the allowed values
- unsupported StageRevision `kind`
- unsupported StageRevision `state`
- StageRun `run_ordinal` at `0` and `1_000_001`
- StageRevision `run_ordinal` at `0` and `1_000_001`
- StageRevision `stage_revision` at `0` and `1_000_001`
- Generation `current_stage_run_ordinal` at `0` and `1_000_001`
- each of `pending_revision`, `published_revision`, and `accepted_revision` at `0` and `1_000_001`

Use updates to an identified seeded row where that isolates the target check. Use an insert for a StageRun ordinal case if updating a seeded run would first encounter a dependent foreign key; the invalid statement must test the allocated bound, not accidentally rely on unrelated seeded references.

```ts
const localIdentityCases = [
  {
    name: "rejects an unsupported Generation format",
    statement: (sql: SqlClient.SqlClient) => sql`
      UPDATE qrspi_generations SET generation_format = 'future_runtime_v2'
      WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
    `,
  },
  {
    name: "rejects a StageRevision ordinal above the durable bound",
    statement: (sql: SqlClient.SqlClient) => sql`
      UPDATE qrspi_stage_revisions SET stage_revision = 1000001
      WHERE workflow_id = ${runtimeFixture.workflowId}
        AND generation = 1
        AND stage_key = ${runtimeFixture.documentStageKey}
        AND stage_revision = ${runtimeFixture.historicalRevision}
    `,
  },
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
```

Generate the six pointer-bound cases from the fixed pointer names only if that remains type-safe and readable. Otherwise list them explicitly. Do not use dynamic column names from arbitrary data.

#### 1.5 Correct only a demonstrated local constraint defect

**File**: `src/store/migrations.ts`

**Changes**: No planned edit. Run the Phase 1 matrix against the existing `0011` checks first. If one allocated statement succeeds, add the smallest missing literal/currentness/ordinal check in the existing `qrspiStageRuntimeLayout` table definition. Do not add a migration `0012`, trigger, semantic lifecycle rule, or unrelated strengthening. Preserve the current metadata assertions and add/update only the exact DDL expectation needed to lock the demonstrated correction.

The expected current definitions already have the intended forms:

```sql
run_ordinal INTEGER NOT NULL CHECK (run_ordinal BETWEEN 1 AND 1000000)
kind TEXT NOT NULL CHECK (kind IN ('document', 'implementation'))
is_current INTEGER NOT NULL CHECK (is_current IN (0, 1))
```

### Success Criteria

#### Automated Verification

- [ ] Focused migration-11 tests and the new local matrix pass: `bun test test/store/migrations.test.ts`
- [ ] TypeScript accepts the fixture, descriptor map, generic assertion, and statement factories: `bun run typecheck`
- [ ] Effect diagnostics remain clean: `bun run effect:check`
- [ ] Every local matrix case is a separate test with a fresh migrated database and one attempted statement.
- [ ] Every case asserts exact equality for all six parent tables and all twelve runtime tables and an empty `PRAGMA foreign_key_check` result.

#### Manual Verification

- [ ] Reconcile the fixture row inventory with the accepted Structure: workflow, ticket revision, workflow definition, both stage definitions, two Generations, physical operations, historical/current/cross-Generation runs, common document and implementation revisions, valid tagged children, three same-run pointers, and one valid Generation cursor are present.
- [ ] Reconcile the local case inventory against both bounds for every allocated run/revision/cursor/pointer ordinal and every allocated format/state/kind/currentness literal.
- [ ] Confirm tagged payload/reference/ownership invalid cases, file-backed upgrade behavior, typed store behavior, and semantic lifecycle claims remain absent.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation that the fixture/snapshot ownership and local matrix match the accepted allocation before proceeding to Phase 2.

---

## Phase 2: Prove Cursor, Currentness, and Same-Run Identity Guards

### Overview

Reuse the fresh-fixture and unchanged-state contract for contradictions that depend on multiple otherwise-valid rows. Prove the Generation cursor is paired and resolves within the same Generation, only one run is current for a stage, owner-crossing identity is global, and each pending/published/accepted pointer resolves to a common revision from the owning run.

### Changes Required

#### 2.1 Add paired and same-Generation cursor cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add three isolated statement factories:

- clear `current_stage_key` while retaining `current_stage_run_ordinal`
- clear `current_stage_run_ordinal` while retaining `current_stage_key`
- point Generation 1 to the valid `(stage_key, run_ordinal)` combination seeded only in Generation 2

The cross-Generation case must use a stage/run pair absent from Generation 1 so rejection proves the four-column Generation-scoped foreign key rather than accidentally selecting another valid run.

```ts
{
  name: "rejects a Generation cursor that resolves only in another Generation",
  statement: (sql: SqlClient.SqlClient) => sql`
    UPDATE qrspi_generations
    SET current_stage_key = ${runtimeFixture.documentStageKey},
        current_stage_run_ordinal = ${runtimeFixture.otherGenerationRunOrdinal}
    WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
  `,
}
```

Each case must pass through `expectIdentitySpineRejection`; do not add a special cursor-only assertion.

#### 2.2 Add one-current-run and global owner-crossing uniqueness cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add separate fresh-fixture cases that:

- insert another otherwise-valid `is_current = 1` StageRun for the current Generation and document stage using a free valid ordinal, proving the partial `qrspi_stage_runs_current` index
- update an otherwise-valid common revision to reuse another seeded revision's `owner_crossing_key`, proving the key is globally unique rather than merely stage- or Generation-scoped

```ts
{
  name: "rejects a second current run for one Generation stage",
  statement: (sql: SqlClient.SqlClient) => sql`
    INSERT INTO qrspi_stage_runs (
      workflow_id, generation, stage_key, run_ordinal,
      workflow_definition_sha256, stage_definition_sha256,
      state, is_current, activation_policy_json,
      created_at, updated_at
    ) VALUES (
      ${runtimeFixture.workflowId}, 1,
      ${runtimeFixture.documentStageKey}, 5,
      ${runtimeFixture.workflowDefinitionSha256},
      ${runtimeFixture.documentStageDefinitionSha256},
      'blocked', 1, '{}', ${timestamp}, ${timestamp}
    )
  `,
}
```

Keep these cases independent. Do not combine duplicate currentness and duplicate owner identity in one statement or fixture mutation.

#### 2.3 Add one cross-run case for each StageRun revision pointer

**File**: `test/store/migrations.test.ts`

**Changes**: Add distinct pending, published, and accepted pointer cases. In each case, update the current run's pointer to `historicalRevision`, which is a valid common revision under the same workflow, Generation, and stage but belongs to `historicalRunOrdinal`. The statement should pass all local ordinal checks and fail only because the five-column pointer foreign key includes the owning `run_ordinal`.

```ts
for (const pointer of [
  "pending_revision",
  "published_revision",
  "accepted_revision",
] as const) {
  test(`rejects a ${pointer} pointer to another run`, async () => {
    await runWithDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seedValidRuntimeIdentitySpine
        yield* expectIdentitySpineRejection(
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
        )
      }),
    )
  })
}
```

The interpolated column name is safe because it comes from the closed `as const` tuple. If lint or type diagnostics reject this shape, list the three statements explicitly rather than adding a generic SQL-construction abstraction.

#### 2.4 Preserve the SQL/application enforcement boundary

**File**: `test/store/migrations.test.ts`

**Changes**: Keep the final matrix and test names limited to constraints the schema actually owns. Do not add negative tests that expect SQLite to reject:

- a cursor to a noncurrent but same-Generation run
- a pending/published/accepted pointer whose revision lifecycle state appears semantically inconsistent
- a noncontiguous or nonmonotonic but locally bounded revision number
- a valid historical-row update or delete solely because history is intended to be append-only at the store boundary

The unchanged snapshot after rejected allocated contradictions is sufficient append-only-history evidence for this Bead. Semantic and coordinated rules remain assigned to later strict reads and guarded store transactions.

#### 2.5 Correct only a demonstrated relational constraint defect

**File**: `src/store/migrations.ts`

**Changes**: No planned edit. If one Phase 2 statement succeeds, correct only the demonstrated paired cursor check, same-Generation cursor foreign key, partial current-run index, owner-crossing unique constraint, or five-column same-run pointer foreign key in `0011`. Preserve all existing names and structural assertions when possible. Do not use a trigger to emulate any relational or lifecycle rule.

The expected existing controls are:

```sql
CHECK ((current_stage_key IS NULL) = (current_stage_run_ordinal IS NULL))

CREATE UNIQUE INDEX qrspi_stage_runs_current
ON qrspi_stage_runs (workflow_id, generation, stage_key)
WHERE is_current = 1

FOREIGN KEY (
  workflow_id, generation, stage_key, run_ordinal, pending_revision
) REFERENCES qrspi_stage_revisions (
  workflow_id, generation, stage_key, run_ordinal, stage_revision
)
```

Any correction must rerun the complete migration-11 metadata suite as well as both rejection phases.

### Success Criteria

#### Automated Verification

- [ ] The complete migration suite, shared harness, local matrix, and relational matrix pass: `bun test test/store/migrations.test.ts`
- [ ] The repository-wide quality gate passes: `bun run check`
- [ ] The patch has no whitespace errors: `git diff --check`
- [ ] Each half-cursor, cross-Generation cursor, duplicate-current, duplicate-owner-key, pending-pointer, published-pointer, and accepted-pointer case uses a fresh valid fixture and attempts exactly one statement.
- [ ] Every rejected statement preserves exact snapshots for all eighteen inventoried tables and leaves `PRAGMA foreign_key_check` empty.

#### Manual Verification

- [ ] Map the completed matrix to the accepted controls: same-Generation cursor, one-current-run, global owner-crossing uniqueness, same-run pending/published/accepted pointers, local format/cursor guards, unchanged seeded history, and foreign-key integrity.
- [ ] Confirm every test name identifies one contradiction and every statement otherwise uses valid identities, tags, ordinals, and parent rows so the intended constraint is isolated.
- [ ] Confirm `src/store/migrations.ts` is unchanged unless a test first demonstrated an allocated gap, and any correction is limited to that exact `0011` constraint or index.
- [ ] Confirm no tagged-child invalid cases, file-backed upgrade claims, typed runtime/store behavior, trigger, progression rule, bootstrap, quarantine, legacy conversion, or parent-gate release is included.
- [ ] Confirm Bead `workflowd-vs3.4.3.1.2.2` can extend the fixture and all-table snapshot without duplicating or replacing their ownership.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation of the final control-to-case reconciliation. This child remains one mandatory result within the unreleased atomic parent migration gate.

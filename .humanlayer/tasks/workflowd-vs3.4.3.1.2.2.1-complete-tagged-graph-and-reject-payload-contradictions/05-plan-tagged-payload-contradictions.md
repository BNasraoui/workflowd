---
task: workflowd-vs3.4.3.1.2.2.1-complete-tagged-graph-and-reject-payload-contradictions
type: plan
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 2e377d5afde717c0746a902264f8704c02707566
---

# Complete the Tagged Graph and Reject Payload Contradictions Implementation Plan

## Overview

Extend the existing real-SQLite migration-11 identity-spine fixture into the complete tagged runtime graph shared by the following reference/diagnostic and operation-ownership children. Then add 51 fresh-database direct-SQL rejection cases covering this Bead's fixed-tag, cross-variant, wrong-parent, source-set, payload, nullable-pair, implementation-step-triad, and position-bound allocation.

Every rejection continues through the existing `expectIdentitySpineRejection` contract so one failed statement must leave all eighteen snapshotted tables exactly unchanged, keep `PRAGMA foreign_keys` enabled, and leave `PRAGMA foreign_key_check` empty. The existing `0011_qrspi_stage_runtime_layout` DDL already appears to enforce every allocated contradiction, so production migration work is contingency-only.

## Current State Analysis

Migration 11 already creates the common StageRun and StageRevision identity spine, separate tagged payload tables, ordered implementation steps, immutable references, diagnostics, and common plus tagged operation-owner tables. The existing test fixture seeds both revision kinds but stops before the complete tagged graph: it has two physical operations, nullable payloads, and no step, reference, checkpoint, diagnostic, or owner row.

The test module already supplies the required isolation mechanics. `runtimeGraphOrder` snapshots all eighteen parent and runtime tables deterministically; `readRuntimeGraph` reads them serially; `seedValidRuntimeIdentitySpine` enables foreign keys and builds the current valid base; and `expectIdentitySpineRejection` proves rejection, exact graph equality, enabled foreign keys, and an empty foreign-key check.

### Key Discoveries

- `test/store/migrations.test.ts:681-716` defines the complete eighteen-table snapshot and deterministic ordering that every new case must retain.
- `test/store/migrations.test.ts:718-935` seeds four runs, five common revisions, four document payload rows, one implementation payload row, and two physical operations; this is the only fixture to extend.
- `test/store/migrations.test.ts:937-949` already implements the full failed-statement contract. New matrices should follow the existing one-test-per-descriptor loops at `test/store/migrations.test.ts:1108-1118` and `test/store/migrations.test.ts:1192-1202` rather than create another helper.
- `test/store/migrations.test.ts:951-981` inventories the positive graph but currently expects two operations and zero rows in every deeper child table. The positive test does not yet expose its foreign-key assertions.
- `src/store/migrations.ts:740-748` enforces source-set array shape and lowercase 64-character SHA-256 shape.
- `src/store/migrations.ts:837-895` enforces fixed document/implementation tags, object-root payloads, lowercase SHA-256 shape, complete nullable pairs, and tagged composite parent identity.
- `src/store/migrations.ts:898-929` enforces implementation parent identity, positions from 1 through 1,000,000, object/hash shape, `final` in `0 | 1`, and either an all-null or complete step triad.
- `src/store/migrations.ts:932-1176` defines the exact insert shapes and dependency order for artifact, commit, checkpoint, diagnostic, common owner, and tagged owner fixture rows.
- SQLite foreign-key enforcement is connection-local, so every case must continue seeding through `seedValidRuntimeIdentitySpine`; malformed JSON may fail either the guarded `CHECK` or JSON function, but both are valid SQL-level rejection under the existing helper.
- SQLite `GLOB` is case-sensitive. Uppercase hexadecimal and non-hex values therefore remain separate named cases, each using a non-null 64-character value so the intended hash check is isolated.
- No production DDL defect is presently demonstrated. Any migration edit must be limited to the smallest failing `0011` check or composite foreign key and its existing exact metadata assertion.

## Desired End State

- `seedValidRuntimeIdentitySpine` creates a valid graph containing one workflow, one ticket revision, one workflow definition, two stage definitions, two Generations, four physical operations, four StageRuns, five common StageRevisions, four document payloads, one implementation payload, one implementation step, one artifact reference, one implementation commit reference, one implementation checkpoint, one revision diagnostic, four common operation owners, two document owner rows, and two implementation-step owner rows.
- The accepted document revision has a non-null prepared-result object/hash pair; the implementation revision has a non-null delivery-evidence object/hash pair; and the implementation step has a complete prepared-result/hash/`final` triad.
- The positive fixture test proves the exact count of every snapshotted table, `PRAGMA foreign_keys = 1`, and `PRAGMA foreign_key_check = []`.
- Five named Phase 1 tests reject wrong fixed tags and document/implementation variant crossings.
- Twelve named Phase 2 tests reject document payload, implementation payload, and implementation-step rows with one wrong workflow, Generation, stage, or revision coordinate.
- Thirty-four named Phase 3 tests reject source-set shape, payload shape, SHA-256 shape, one-sided nullable pairs, every incomplete step triad, invalid `final` values, and both position bounds.
- Every invalid statement starts with a fresh database and the complete valid fixture, attempts one contradiction, and uses `expectIdentitySpineRejection` unchanged.
- `bun test test/store/migrations.test.ts`, `bun run check`, and `git diff --check` pass after final reconciliation.

## What We're NOT Doing

- Adding immutable-reference or diagnostic rejection cases, including diagnostic nullable-pair behavior assigned to the following sibling.
- Adding common-owner or tagged-owner rejection cases, duplicate-role cases, role/kind disagreement cases, or cross-owner physical-operation reuse cases assigned to the operation-ownership sibling.
- Proving canonical hash equality, source-set collection semantics, tagged aggregate completeness, or any other cross-row semantic invariant.
- Adding Effect Schemas, typed store APIs, transactions, transitions, triggers, claim behavior, bootstrap behavior, quarantine behavior, runtime orchestration, or neighboring lifecycles.
- Adding upgrade-preservation or legacy-conversion coverage.
- Creating a new migration or editing `src/store/migrations.ts` unless a named allocated statement demonstrates a missing `0011` local constraint.
- Completing or releasing the parent migration gate. This Bead remains one SQL-local contribution to the parent's atomic reconciliation.

## Implementation Approach

Keep all planned work in `test/store/migrations.test.ts`. First deepen the existing fixture in dependency order so every later invalid statement begins from the same complete graph. Next add separate descriptor matrices for variant and wrong-parent contradictions. Finally add local source-set, payload, pair, triad, and bound matrices using failed `UPDATE`s against seeded rows where possible and failed `INSERT`s at unused identities where insertion itself is the behavior under test.

Do not add another snapshot or rejection abstraction. The existing helper is deliberately the shared contract. Use lowercase fixed-width literals for valid local hashes, distinct operation IDs for the four physical operations, position `1` for the seeded implementation step, and position `2` for otherwise-valid inserted step-shape cases so failures cannot be caused by a primary-key collision. Use the seeded row for failed updates when testing nullable combinations.

If an allocated statement succeeds, first verify that the statement is otherwise valid and isolates only the intended contradiction. Only then make the smallest correction inside `qrspiStageRuntimeLayout` and extend the existing exact DDL metadata test. Do not broaden the migration or add application-level behavior.

---

## Phase 1: Complete the Tagged Graph and Reject Variant Mismatches

### Overview

Build the complete sibling-consumable fixture frontier, make its integrity explicit in the positive test, and prove the fixed document/implementation tags and tagged parent boundaries cannot be crossed.

### Changes Required

#### 1.1 Add Stable Tagged Fixture Values

**File**: `test/store/migrations.test.ts`

**Changes**: Extend `runtimeFixture` around `test/store/migrations.test.ts:718-733` with the implementation step position, valid object payloads, valid lowercase SHA-256 values, and stable operation IDs used by the new rows. Keep these literals centralized so valid inserts and invalid-case matrices differ only in the field under test.

```diff
 const runtimeFixture = {
   // existing workflow, stage, run, and revision identities
+  implementationStepPosition: 1,
+  documentPreparedResultJson: '{"result":"document-ready"}',
+  documentPreparedResultSha256: "1".repeat(64),
+  implementationEvidenceJson: '{"result":"implementation-ready"}',
+  implementationEvidenceSha256: "2".repeat(64),
+  stepPreparedResultJson: '{"result":"step-ready"}',
+  stepPreparedResultSha256: "3".repeat(64),
+  documentProduceOperationId: "runtime-document-produce-r1",
+  documentPublishOperationId: "runtime-document-publish-r1",
+  implementationProduceOperationId: "runtime-implementation-produce-r1",
+  implementationPublishOperationId: "runtime-implementation-publish-r1",
 } as const
```

Rename the two existing operation IDs only if needed to make their owner clear; update all fixture references atomically if renamed. Do not alter operation lifecycle semantics beyond adding the second producer/publication pair.

#### 1.2 Extend the Seed in Foreign-Key Dependency Order

**File**: `test/store/migrations.test.ts`

**Changes**: Update `seedValidRuntimeIdentitySpine` around `test/store/migrations.test.ts:803-935` in this order:

1. Seed four `workflow_operations`: document `StageProduce` and `ArtifactPublish`, then implementation-step `StageProduce` and `ArtifactPublish`.
2. Give document revision 4 a complete prepared-result pair while revisions 1-3 remain the valid all-null pair.
3. Give implementation revision 1 a complete prepared-delivery-evidence pair.
4. Insert implementation step position 1 with a complete prepared-result/hash/`final = 1` triad.
5. Insert one artifact reference under document revision 4.
6. Insert one implementation commit reference under implementation revision 1, step 1, with a nonempty changed-path array.
7. Insert one implementation checkpoint under implementation revision 1, using the seeded delivery-evidence hash.
8. Insert one valid bounded revision diagnostic as fixture data only.
9. Insert four common operation-owner rows after all physical operations exist.
10. Insert document produce/publish owner rows and implementation-step produce/publish owner rows after their common owners and relational parents exist.
11. Preserve the existing pointer updates at the end of the seed.

The tagged payload and step inserts should follow this shape:

```ts
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
```

The reference fixture must satisfy the existing local checks without claiming semantic hash equality:

```ts
yield* sql`
  INSERT INTO qrspi_implementation_commit_references (
    workflow_id, generation, stage_key, stage_revision, position,
    provider_instance_id, repository_id, repository_full_name,
    commit_sha, expected_parent_sha, changed_paths_json,
    changed_paths_sha256, created_at, updated_at
  ) VALUES (
    ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1, 1,
    'github.com', 'repository-42', 'example/workflowd', ${"4".repeat(40)},
    ${"5".repeat(40)}, '["src/main.ts"]', ${"6".repeat(64)},
    ${timestamp}, ${timestamp}
  )
`
```

Seed operation ownership common-first, tagged-second:

```ts
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
```

Keep artifact, commit, checkpoint, diagnostic, and owner rows as positive fixture data only. This phase must not test their sibling-owned contradictions.

#### 1.3 Prove the Exact Complete Graph and Foreign-Key State

**File**: `test/store/migrations.test.ts`

**Changes**: Extend the positive test around `test/store/migrations.test.ts:951-982` to return the table counts together with both foreign-key observations.

```diff
 test("seeds the complete valid tagged runtime graph", async () => {
-  const counts = await runWithDatabase(
+  const result = await runWithDatabase(
     Effect.gen(function* () {
+      const sql = yield* SqlClient.SqlClient
       yield* seedValidRuntimeIdentitySpine
       const graph = yield* readRuntimeGraph
-      return Object.fromEntries(/* count entries */)
+      return {
+        counts: Object.fromEntries(
+          Object.entries(graph).map(([table, rows]) => [table, rows.length]),
+        ),
+        foreignKeys: yield* sql`PRAGMA foreign_keys`,
+        foreignKeyViolations: yield* sql`PRAGMA foreign_key_check`,
+      }
     }),
   )

+  expect(result.foreignKeys).toEqual([{ foreign_keys: 1 }])
+  expect(result.foreignKeyViolations).toEqual([])
 })
```

Assert this exact inventory:

```ts
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
```

#### 1.4 Add the Five Fixed-Tag and Cross-Variant Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add a `taggedVariantCases` descriptor matrix after the positive fixture test. Include exactly these named behaviors:

- Reject a document payload whose `kind` is `implementation`.
- Reject an implementation payload whose `kind` is `document`.
- Reject an otherwise-valid document payload attached to the implementation common revision.
- Reject an otherwise-valid implementation payload attached to a document common revision.
- Reject an otherwise-valid implementation step attached to a document payload identity.

Use failed updates for fixed-tag cases and inserts at cross-variant identities for parent-tag cases. For example:

```ts
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
    name: "rejects a document payload attached to an implementation StageRevision",
    statement: (sql: SqlClient.SqlClient) => sql`
      INSERT INTO qrspi_document_stage_revisions (
        workflow_id, generation, stage_key, stage_revision, kind,
        prepared_result_json, prepared_result_sha256, created_at, updated_at
      ) VALUES (
        ${runtimeFixture.workflowId}, 1, ${runtimeFixture.implementationStageKey}, 1,
        'document', ${runtimeFixture.documentPreparedResultJson},
        ${runtimeFixture.documentPreparedResultSha256}, ${timestamp}, ${timestamp}
      )
    `,
  },
  // implementation fixed tag, implementation-on-document, step-on-document
] as const
```

Run each descriptor through one fresh `runWithDatabase`, one seed, and one helper call:

```ts
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
```

#### 1.5 Contingency-Only Constraint Correction

**File**: `src/store/migrations.ts`

**Changes**: No planned edit. If one of the five named statements is accepted after confirming it isolates the intended contradiction, correct only the corresponding fixed-tag check or tagged composite foreign key in `qrspiStageRuntimeLayout` at `src/store/migrations.ts:837-929`. Update the matching exact metadata assertion in `test/store/migrations.test.ts:1946-2372`; do not add a new migration or unrelated constraint.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Reconcile the positive count object against all eighteen keys in `runtimeGraphOrder`; no table is omitted or counted outside the complete snapshot.
- [ ] Inspect seed order and verify every artifact, commit, checkpoint, diagnostic, common owner, and tagged owner row is valid fixture-only data, with no sibling-owned rejection case added.
- [ ] Confirm all five variant tests use a fresh database and differ from the valid fixture only in the fixed tag or tagged parent boundary named by the test.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation before proceeding to Phase 2.

---

## Phase 2: Reject Wrong-Parent Tagged Identities

### Overview

Prove that document payloads, implementation payloads, and implementation steps remain attached to their exact relational parent. Each case preserves valid tags, payloads, hashes, triads, and local bounds while changing one workflow, Generation, stage, or revision coordinate.

### Changes Required

#### 2.1 Add the Twelve Wrong-Parent Descriptors

**File**: `test/store/migrations.test.ts`

**Changes**: Add a `taggedParentIdentityCases` matrix grouped by child table. The exact executable coverage is:

| Child | Wrong workflow | Wrong Generation | Wrong stage | Wrong revision |
| --- | --- | --- | --- | --- |
| Document payload | 1 case | 1 case | 1 case | 1 case |
| Implementation payload | 1 case | 1 case | 1 case | 1 case |
| Implementation step | 1 case | 1 case | 1 case | 1 case |

Use explicit names such as `rejects a document payload with the wrong workflow` so acceptance reconciliation does not depend on array indexes. Keep all non-coordinate values valid:

```ts
const taggedParentIdentityCases = [
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
  // ten remaining child/coordinate combinations
] as const
```

For wrong workflow use a nonempty absent workflow ID. For wrong Generation use positive Generation `2`. For wrong stage use the opposite existing stage key. For wrong revision use a positive absent revision such as `5`. These choices remain locally valid and isolate the composite foreign key. Use position `2` for step inserts so the seeded position-1 primary key cannot become the rejection cause.

There is no separate wrong-position parent case for `qrspi_implementation_steps`: position is the step's own local identity, and its lower/upper bounds belong to Phase 3. Wrong-step identity on commit references remains sibling-owned reference coverage.

#### 2.2 Preserve Fresh Complete-Graph Isolation

**File**: `test/store/migrations.test.ts`

**Changes**: Execute every descriptor through the same fresh-database loop used in Phase 1. Do not batch statements with `Effect.all` inside one seeded database, and do not weaken `expectIdentitySpineRejection` to compare only affected tables.

```ts
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
```

#### 2.3 Contingency-Only Composite Foreign-Key Correction

**File**: `src/store/migrations.ts`

**Changes**: No planned edit. If one of the twelve otherwise-valid rows is accepted, correct only its demonstrated composite parent foreign key in `0011_qrspi_stage_runtime_layout` and update the corresponding exact foreign-key metadata expectation in `test/store/migrations.test.ts:1946-2372`. Do not add semantic identity checks or touch reference/diagnostic/owner relationships.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Count exactly twelve wrong-parent tests: four document payload, four implementation payload, and four implementation-step cases.
- [ ] Confirm every case changes exactly one of workflow, Generation, stage, or revision while retaining a valid tag, JSON object, lowercase 64-character hash, complete triad where applicable, and locally valid position.
- [ ] Confirm no case claims wrong reference parentage, diagnostic parentage, operation ownership, nested semantic identity, or canonical hash validation.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation before proceeding to Phase 3.

---

## Phase 3: Reject Payload Shapes, Pairs, Triads, and Bounds

### Overview

Complete this Bead's SQL-local matrix with 34 source-set, payload, nullable-pair, implementation-step-triad, `final`, and position cases. Reconcile the final 51-case allocation and run the full repository quality gate without expanding into semantic or sibling-owned behavior.

### Changes Required

#### 3.1 Add Five Common Source-Set Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add failed updates against a seeded common StageRevision for:

- Malformed `source_set_json`, such as `'{not-json'`.
- Object-root `source_set_json`, such as `'{}'`, where an array is required.
- Wrong-length `source_set_sha256`, such as 63 lowercase characters.
- Uppercase `source_set_sha256`, using 64 uppercase hexadecimal characters.
- Non-hex `source_set_sha256`, using 63 lowercase hexadecimal characters plus `g`.

```ts
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
  // object root and three hash-shape cases
] as const
```

Do not add empty-array rejection or canonical hash comparison. The current SQL contract accepts arrays based on local root shape only.

#### 3.2 Add Fourteen Tagged Payload Shape and Pair Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add seven document prepared-result cases and seven implementation delivery-evidence cases. Each variant needs:

- Malformed JSON.
- Array-root JSON where an object is required.
- Wrong-length SHA-256.
- Uppercase SHA-256.
- Non-hex SHA-256.
- JSON present with hash `NULL`.
- Hash present with JSON `NULL`.

Use the seeded complete pair and failed updates so the one-sided tests isolate the explicit pair equality check:

```ts
{
  name: "rejects document prepared-result JSON without its hash",
  statement: (sql: SqlClient.SqlClient) => sql`
    UPDATE qrspi_document_stage_revisions
    SET prepared_result_sha256 = NULL
    WHERE workflow_id = ${runtimeFixture.workflowId} AND generation = 1
      AND stage_key = ${runtimeFixture.documentStageKey}
      AND stage_revision = ${runtimeFixture.acceptedRevision}
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
}
```

Keep tested hashes non-null in hash-shape cases. This avoids SQLite nullable `CHECK` behavior and ensures the intended length or `GLOB` predicate rejects the row.

#### 3.3 Add Thirteen Implementation-Step Triad and Value Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Cover all six invalid presence combinations of `prepared_result_json`, `prepared_result_sha256`, and `final`:

| JSON | Hash | `final` | Expected |
| --- | --- | --- | --- |
| present | null | null | reject |
| null | present | null | reject |
| null | null | present | reject |
| present | present | null | reject |
| present | null | present | reject |
| null | present | present | reject |

Add seven value-shape cases while retaining a complete non-null triad:

- Malformed prepared-result JSON.
- Array-root prepared-result JSON.
- Wrong-length prepared-result SHA-256.
- Uppercase prepared-result SHA-256.
- Non-hex prepared-result SHA-256.
- `final = -1`.
- `final = 2`.

Generate the six presence cases from explicit descriptors if that keeps names and values reviewable:

```ts
const incompleteStepTriads = [
  {
    name: "rejects a step with only prepared-result JSON",
    preparedResultJson: runtimeFixture.stepPreparedResultJson,
    preparedResultSha256: null,
    final: null,
  },
  // only hash; only final; JSON+hash; JSON+final; hash+final
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
      AND stage_revision = 1 AND position = ${runtimeFixture.implementationStepPosition}
  `,
}))
```

The seeded complete triad is the positive control. The existing document revisions 1-3 preserve valid all-null payload pairs; do not create a rejection case for either valid step-triad shape.

#### 3.4 Add the Two Position-Bound Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Insert an otherwise-valid implementation step at positions `0` and `1_000_001`. Keep a complete valid JSON/hash/`final` triad and the exact implementation parent identity so only `position BETWEEN 1 AND 1000000` can reject the row.

```ts
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
```

#### 3.5 Execute Every Local Case Through the Shared Contract

**File**: `test/store/migrations.test.ts`

**Changes**: Combine the Phase 3 descriptor groups only for iteration, preserving each named Bun test and fresh database:

```ts
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
```

The matrix must total 34 Phase 3 cases: 5 source-set, 7 document payload, 7 implementation payload, 13 step triad/value, and 2 step-bound cases. Together with Phases 1 and 2, the final allocation is 51 named rejection tests.

#### 3.6 Reconcile Scope and Apply Only Demonstrated DDL Corrections

**Files**: `test/store/migrations.test.ts`; contingency-only `src/store/migrations.ts`

**Changes**: Reconcile executable names against every Bead acceptance item. If a named local case is unexpectedly accepted, first rule out an invalid test setup, primary-key collision, nullable `CHECK` result, or disabled foreign key. Then correct only the demonstrated `0011` check and update the existing metadata snippet assertion around `test/store/migrations.test.ts:1937-2051`.

Do not add reference/diagnostic contradiction tests, owner contradiction tests, canonical hash comparisons, collection-content rules, or application behavior while reconciling. If production work broadens beyond the accepted contingency or the total implementation exceeds the 960-line high estimate, stop and repeat scope review rather than dropping matrix coverage.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Reconcile exactly 51 new named rejection cases: 5 variant, 12 wrong-parent, 5 source-set, 7 document payload, 7 implementation payload, 13 step triad/value, and 2 step-bound cases.
- [ ] Confirm every descriptor gets a fresh `runWithDatabase`, complete seed, one failed statement, exact eighteen-table before/after comparison, enabled foreign-key assertion, and empty foreign-key-check assertion.
- [ ] Verify malformed and wrong-root JSON remain distinct, and wrong-length, uppercase, and non-hex SHA-256 values remain three distinct non-null cases for every allocated hash field.
- [ ] Verify the six invalid step-presence combinations are complete and the all-null and complete triads remain valid controls.
- [ ] Inspect the final diff and confirm it contains no sibling-owned reference/diagnostic or operation-owner rejection case, typed store API, semantic/canonical-hash claim, trigger, runtime behavior, upgrade proof, legacy conversion, child coordination, or parent-gate release claim.
- [ ] If `src/store/migrations.ts` changed, tie every changed DDL line to a previously accepted named statement and its exact metadata assertion; otherwise confirm the production migration remains untouched.

**Implementation Note**: After completing this phase and all automated verification passes, pause for final human confirmation. Passing this plan completes only this Bead's bounded SQL-local evidence and does not release the parent migration gate.

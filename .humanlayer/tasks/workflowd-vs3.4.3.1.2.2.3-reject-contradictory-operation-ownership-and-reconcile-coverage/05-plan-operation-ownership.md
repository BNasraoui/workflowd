---
task: workflowd-vs3.4.3.1.2.2.3-reject-contradictory-operation-ownership-and-reconcile-coverage
type: plan
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: dab5b90a11c4276b3d1c7d765f919b9b136ec8f7
---

# Reject Contradictory Operation Ownership and Reconcile Coverage Implementation Plan

## Overview

Add 36 named real-SQLite rejection tests around the complete tagged runtime fixture. The tests will prove that a physical `workflow_operations` row, its common `qrspi_stage_operation_owners` row, and either tagged owner row cannot disagree on operation kind, owner variant, role, or exact relational parent. They will also prove parent-plus-role uniqueness, same-table physical-operation uniqueness, and both cross-owner reuse directions.

Every rejected statement will run in a fresh database after `seedValidRuntimeIdentitySpine`, with any additional valid setup completed before `expectIdentitySpineRejection` captures its snapshot. The shared helper will continue to prove statement rejection, exact before/after equality across all eighteen graph tables, enabled foreign keys, and an empty `PRAGMA foreign_key_check`. The current `0011_qrspi_stage_runtime_layout` appears to enforce the full allocation, so `src/store/migrations.ts` remains a tests-first contingency rather than a planned production edit.

## Current State Analysis

The completed dependency already seeds the entire graph needed by this child: four physical operations, four common owners, two document operation rows, and two implementation-step operation rows. It also provides a deterministic full-graph reader and the exact rejection contract. What is missing is direct invalid-write evidence for the ownership-specific checks, keys, and composite foreign keys, plus a named reconciliation of those tests to this Bead's acceptance subset.

Migration 11 declares the intended ownership chain. The common table restricts local vocabulary, pairs role with operation kind, references the physical operation by `(operation_id, kind)`, and uses `operation_id` as its primary key. Each tagged table has a fixed owner tag, a parent-plus-role primary key, `UNIQUE (operation_id)`, an exact parent foreign key, and a composite foreign key back to the common owner tuple.

### Key Discoveries

- `test/store/migrations.test.ts:665-716` defines the migration-11 describe block, eighteen-table snapshot order, and deterministic graph reader that all new tests must reuse.
- `test/store/migrations.test.ts:718-744` centralizes stable runtime identities, including the four operation IDs consumed by this plan.
- `test/store/migrations.test.ts:746-1073` seeds the complete valid graph in dependency order, including physical operations at lines 813-852, common owners at lines 1018-1030, and both tagged variants at lines 1031-1056.
- `test/store/migrations.test.ts:1075-1087` already proves rejection, exact full-graph equality, `PRAGMA foreign_keys = 1`, and an empty `PRAGMA foreign_key_check`; no second rejection helper is needed.
- `test/store/migrations.test.ts:1129-1717` establishes the repository pattern of named descriptor arrays, one fresh `runWithDatabase` invocation per descriptor, one complete seed, and one rejected statement.
- `test/store/migrations.test.ts:2681-3107` already asserts exact columns, foreign keys, and DDL snippets for all three ownership tables. A demonstrated migration correction belongs in this existing metadata inventory.
- `test/store/migrations.test.ts:3109-3212` already asserts the physical `(operation_id, kind)` index, common owner indexes, tagged parent-plus-role primary keys, and tagged `UNIQUE (operation_id)` indexes.
- `src/store/migrations.ts:1097-1119` defines the physical-kind key, common owner vocabulary, role/kind pairing, and physical-operation composite foreign key.
- `src/store/migrations.ts:1125-1176` defines the exact document-revision and implementation-step parent foreign keys, fixed owner tags, common-owner tuple foreign keys, parent-plus-role primary keys, and per-table operation uniqueness.
- The common owner's `operation_id` primary key is the cross-owner uniqueness boundary. The tagged tables do not need a cross-table unique index because both variants must reference the one common tuple for that physical operation.
- A spare valid physical operation and common owner must be inserted before the helper's before-snapshot whenever an invalid tagged insert cannot safely reuse a fixture operation. Otherwise a seeded primary key or `UNIQUE (operation_id)` collision could hide the intended parent or tuple foreign-key rejection.
- The accepted ancestor Design assigns local checks, keys, foreign keys, and uniqueness to SQL while leaving producer, publisher, claim, progression, and neighboring lifecycle behavior outside this child. This plan exercises only the narrow D3 ownership seam plus D4, C1/V1, and R1 evidence.

## Desired End State

- Seven named common-owner tests reject unsupported operation, owner, and role tags; both role/kind inversions; a physical-kind mismatch; and a missing physical operation.
- Nine named document-owner tests reject the wrong fixed tag; wrong workflow, Generation, stage, and revision parents; both revision bounds; and owner-kind or role disagreement with the common tuple.
- Twelve named implementation-step-owner tests reject the wrong fixed tag; wrong workflow, Generation, stage, revision, and position parents; both revision and position bounds; and owner-kind or role disagreement with the common tuple.
- Four named duplicate-role tests reject a second `produce` or `publish` operation for one document revision or implementation step while using a distinct valid physical operation and common owner.
- Two named same-table reuse tests reject assigning an already-owned physical operation to a different valid document revision or implementation step.
- Two named cross-owner tests reject both attempts to reuse one physical operation across document-revision and implementation-step variants through the common-owner tuple.
- All 36 tests use one fresh database, one complete seed, optional valid setup before the snapshot, one contradictory statement, exact graph preservation, enabled foreign keys, and an empty foreign-key check.
- The executable case groups reconcile common vocabulary and role/kind checks, physical-kind identity, exact tagged parents, tagged common tuples, duplicate-role keys, same-table operation uniqueness, and cross-owner common-spine uniqueness to this Bead only.
- `bun test test/store/migrations.test.ts`, `bun run check`, and `git diff --check` pass. Passing this child supplies evidence to the parent but does not complete or release the parent migration gate.

## What We're NOT Doing

- Extending the complete fixture or adding payload, source-set, nullable-pair, triad, or step-bound rejection owned by the completed payload child.
- Adding immutable-reference or diagnostic rejection owned by the reference/diagnostic child.
- Proving canonical hash equality, coordinated tagged-child completeness, or any other cross-row semantic invariant.
- Adding typed Schemas, store APIs, transactions, triggers, claim behavior, producer behavior, publisher behavior, allocation, transition, progression, bootstrap, quarantine, runtime execution, upgrade preservation, or legacy conversion.
- Adding publication reconciliation, handoff receipt, delivery, TargetReconcile, or neighboring owner lifecycle state.
- Creating compatibility machinery, a new migration, or a broad rewrite of `0011_qrspi_stage_runtime_layout`.
- Treating this child's passing tests as completion, approval, authentication, or release of the parent migration gate.

## Implementation Approach

Keep the expected implementation in `test/store/migrations.test.ts` inside the existing migration-11 describe block. Add one small reusable operation insert helper because many cases need a distinct otherwise-valid physical operation. Represent each case as a named descriptor with an optional `setup` Effect and a `statement` factory. The shared loop will seed the complete fixture, execute valid setup, and only then call `expectIdentitySpineRejection`, preserving the helper's snapshot boundary.

Organize descriptors by the relational boundary they prove rather than by SQL syntax: common owner, document owner, implementation-step owner, and role/reuse. Keep one contradiction per test. Use explicit names so coverage can be reconciled from test output without relying on array positions.

For parent and tuple tests, create a fresh operation ID and matching common owner before the snapshot. For duplicate-role tests, use a fresh common owner with the same role as the seeded tagged row so the parent-plus-role primary key is the first conflict. For same-table reuse, use an existing common owner and a different valid parent so `UNIQUE (operation_id)` is isolated. For cross-owner reuse, use a different valid parent that has no row for the attempted role so the common tuple foreign key, not a tagged primary key, rejects the crossing.

If a named case succeeds, first confirm foreign keys are enabled and the statement is otherwise valid, locally bounded, collision-free, and aimed at the intended constraint. Only then edit the smallest corresponding `0011` check, key, unique constraint, or composite foreign key and extend the existing exact metadata assertion. No failure may be resolved by weakening the test, graph snapshot, foreign-key assertions, or authority boundary.

---

## Phase 1: Reject Common Owner and Physical Operation Disagreement

### Overview

Prove the common ownership spine accepts only the allocated operation kinds, owner variants, and roles; pairs each role with the correct kind; and identifies an existing physical WorkflowOperation of that same kind.

### Changes Required

#### 1.1 Add a Reusable Valid Physical-Operation Insert

**File**: `test/store/migrations.test.ts`

**Changes**: Add a local helper after `runtimeFixture` and before `seedValidRuntimeIdentitySpine`. It should insert one otherwise-valid current WorkflowOperation while allowing the operation ID and physical kind to vary. Keep all lifecycle values equivalent to the valid fixture; this helper creates setup facts only and does not introduce operation behavior.

```ts
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
```

Use unique `operation_id` and `logical_operation_id` values per test. `ReviewContribute` is included only so the unsupported common `operation_kind` test can name an existing physical operation of that kind and isolate the common table's local vocabulary check.

#### 1.2 Add the Seven Common-Owner Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add a `commonOperationOwnerCases` descriptor matrix after the existing payload matrices and before metadata assertions. Cover this exact allocation:

| Boundary | Named case | Valid setup before snapshot | Rejected value |
| --- | --- | --- | --- |
| Operation vocabulary | unsupported common operation kind | physical `ReviewContribute` operation | common `operation_kind = 'ReviewContribute'` |
| Owner vocabulary | unsupported common owner kind | physical `StageProduce` operation | `owner_kind = 'stage_run'` |
| Role vocabulary | unsupported common operation role | physical `StageProduce` operation | `operation_role = 'review'` |
| Role/kind pairing | produce paired with publish kind | physical `ArtifactPublish` operation | `operation_kind = 'ArtifactPublish'`, role `produce` |
| Role/kind pairing | publish paired with produce kind | physical `StageProduce` operation | `operation_kind = 'StageProduce'`, role `publish` |
| Physical kind identity | declared kind differs from physical operation | physical `ArtifactPublish` operation | common `StageProduce`/`produce` tuple |
| Physical existence | missing physical operation | none | otherwise-valid `StageProduce`/document/`produce` tuple |

Use the optional setup shape so physical rows are part of the accepted before-state:

```ts
const commonOperationOwnerCases = [
  {
    name: "rejects a common owner with an unsupported operation kind",
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
    name: "rejects a common owner whose declared kind differs from its physical operation",
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
  // unsupported owner, unsupported role, both role/kind inversions, missing operation
] as const
```

#### 1.3 Execute Each Case in a Fresh Complete Graph

**File**: `test/store/migrations.test.ts`

**Changes**: Add one shared loop for the Phase 1 descriptors. Run setup after the complete seed and before the helper so successful setup rows are included in both snapshots.

```ts
for (const testCase of commonOperationOwnerCases) {
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
```

Do not batch cases in one database and do not insert setup inside the rejected statement Effect.

#### 1.4 Contingency-Only Common Constraint Correction

**Files**: `src/store/migrations.ts`; `test/store/migrations.test.ts`

**Changes**: No planned migration edit. If an isolated case succeeds, correct only the demonstrated common-owner vocabulary check, role/kind pairing check, or `(operation_id, operation_kind)` foreign key at `src/store/migrations.ts:1097-1119`. Update the corresponding DDL, foreign-key, or index expectation in the existing metadata tests at `test/store/migrations.test.ts:2937-2961` or `3109-3212`.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Count exactly seven common-owner tests and map each to one of local vocabulary, role/kind pairing, physical kind, or physical existence.
- [ ] Confirm the physical-kind mismatch has a locally valid common role/kind pair and an existing physical operation, so only the composite foreign key disagrees.
- [ ] Confirm every setup row is inserted before `expectIdentitySpineRejection` and the rejected insert is the only statement inside the helper.
- [ ] Confirm no test claims that SQL coordinates common rows with tagged children; that evidence begins in Phase 2.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation before proceeding to Phase 2.

---

## Phase 2: Reject Tagged Owner Identity and Tuple Disagreement

### Overview

Extend the proof through both tagged owner tables. Each rejected insert or update will retain valid remaining fields while changing one fixed tag, parent coordinate, local bound, or common-owner tuple component.

### Changes Required

#### 2.1 Add a Common-Owner Setup Helper

**File**: `test/store/migrations.test.ts`

**Changes**: Add a helper that composes `insertRuntimeOperation` with one valid common owner. It will be reused by Phase 2 parent/tuple cases and Phase 3 duplicate-role cases.

```ts
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
```

Callers must choose matching `StageProduce`/`produce` or `ArtifactPublish`/`publish` pairs. Deliberate tuple disagreement belongs only in the attempted tagged row.

#### 2.2 Add the Nine Document-Owner Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add `documentOperationOwnerCases` with exactly these cases:

| Group | Cases |
| --- | --- |
| Fixed tag | update an existing document owner to `owner_kind = 'implementation_step'` |
| Exact parent | insert with wrong workflow, Generation, stage, or revision |
| Bounds | insert with `stage_revision = 0` and `stage_revision = 1_000_001` |
| Common tuple | insert with common `owner_kind = 'implementation_step'` but tagged document owner; insert with common role `publish` but tagged role `produce` |

Every insert case should use a unique spare operation/common owner so a seeded tagged row cannot cause `UNIQUE (operation_id)` first. The wrong-parent and bound cases should use a valid document/`produce` common tuple. The tuple cases should retain the tagged table's required `document_revision` value and change only the common tuple.

```ts
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
}
```

For wrong workflow use a nonempty absent workflow ID; for wrong Generation use existing positive Generation `2`; for wrong stage use the implementation stage; and for wrong revision use positive absent revision `5`. These values are locally valid and isolate the exact document-payload parent foreign key.

#### 2.3 Add the Twelve Implementation-Step-Owner Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add `implementationStepOperationOwnerCases` with exactly these cases:

| Group | Cases |
| --- | --- |
| Fixed tag | update an existing implementation owner to `owner_kind = 'document_revision'` |
| Exact parent | insert with wrong workflow, Generation, stage, revision, or position |
| Bounds | insert with revision `0` and `1_000_001`; insert with position `0` and `1_000_001` |
| Common tuple | insert with common `owner_kind = 'document_revision'` but tagged implementation owner; insert with common role `publish` but tagged role `produce` |

Use one spare operation/common owner per insert. For the wrong-position parent case use locally valid absent position `2`; for wrong revision use `5`. Bound cases retain every other exact implementation-step coordinate.

```ts
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
}
```

#### 2.4 Execute Both Tagged Matrices Through the Shared Contract

**File**: `test/store/migrations.test.ts`

**Changes**: Combine the two descriptor groups only for iteration. Preserve each explicit test name and fresh database.

```ts
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
```

#### 2.5 Contingency-Only Tagged Constraint Correction

**Files**: `src/store/migrations.ts`; `test/store/migrations.test.ts`

**Changes**: No planned migration edit. If one case succeeds, correct only its fixed owner check, local ordinal check, exact parent foreign key, or common-owner tuple foreign key at `src/store/migrations.ts:1125-1176`. Extend the matching exact DDL or foreign-key expectation at `test/store/migrations.test.ts:2962-3020`. Do not add cross-row semantic checks or application behavior.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Count exactly nine document-owner and twelve implementation-step-owner tests.
- [ ] Confirm each wrong-parent case changes one coordinate while preserving fixed owner tag, role, physical kind, common tuple, and all remaining parent coordinates.
- [ ] Confirm revision and position bound cases use otherwise-valid exact parents and valid operation/common-owner setup.
- [ ] Confirm tuple disagreement cases avoid tagged primary-key and operation-unique collisions and differ from their common owner in only owner kind or operation role.
- [ ] Confirm every spare physical operation and common owner is accepted before the helper's before-snapshot.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation before proceeding to Phase 3.

---

## Phase 3: Reject Ownership Reuse and Reconcile Coverage

### Overview

Close the matrix over parent-plus-role uniqueness and single physical-operation ownership, then reconcile all 36 named tests to this Bead's exact acceptance and authority boundary.

### Changes Required

#### 3.1 Add Four Duplicate-Role Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add one case for each tagged parent and role:

- A document revision cannot acquire a second `produce` operation.
- A document revision cannot acquire a second `publish` operation.
- An implementation step cannot acquire a second `produce` operation.
- An implementation step cannot acquire a second `publish` operation.

For each case, setup a distinct valid physical operation and matching common owner. Attempt to attach it to the already-owned parent and role. Because the operation is unused and the common tuple is valid, the parent-plus-role primary key is the intended rejection boundary.

```ts
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
}
```

#### 3.2 Add Two Same-Table Physical-Operation Reuse Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Exercise each tagged table's `UNIQUE (operation_id)` without changing the shared fixture globally:

- Attempt to attach `documentProduceOperationId` to document revision 2 with role `produce`. Revision 2 already has a valid document payload and no owner row, so its parent-plus-role identity is free while the operation is already owned by revision 4.
- Insert a second valid implementation step at position 2 before the snapshot, then attempt to attach `implementationProduceOperationId` to that step with role `produce`. The new parent identity is free while the operation is already owned by position 1.

Add only the small implementation-step setup needed by the second case:

```ts
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
```

The all-null triad is valid fixture setup and is inserted before `expectIdentitySpineRejection`.

#### 3.3 Add Both Cross-Owner Reuse Directions

**File**: `test/store/migrations.test.ts`

**Changes**: Prove one physical operation cannot cross owner variants through the common spine:

- After inserting implementation step position 2, attempt to attach `documentProduceOperationId` to that step as `implementation_step`/`produce`. The implementation parent-plus-role is free and the implementation table has not used that operation, but the common row says `document_revision`.
- Attempt to attach `implementationProduceOperationId` to document revision 2 as `document_revision`/`produce`. The document parent-plus-role is free and the document table has not used that operation, but the common row says `implementation_step`.

Do not create a second common owner for either physical operation. Its `operation_id` primary key is the single common ownership decision being proved, and each attempted tagged composite foreign key must fail against that existing tuple.

#### 3.4 Execute the Eight Role and Reuse Cases

**File**: `test/store/migrations.test.ts`

**Changes**: Add `operationOwnershipReuseCases` containing four duplicate-role, two same-table reuse, and two cross-owner cases. Run the same fresh-database, optional-setup, rejection-helper contract used in the prior phases.

The case count and intended constraints are:

| Evidence | Count | Intended boundary |
| --- | ---: | --- |
| Document duplicate roles | 2 | document parent-plus-role primary key |
| Implementation duplicate roles | 2 | implementation parent-plus-role primary key |
| Document same-table reuse | 1 | document `UNIQUE (operation_id)` |
| Implementation same-table reuse | 1 | implementation `UNIQUE (operation_id)` |
| Document operation crossed to implementation | 1 | tagged common-owner tuple foreign key |
| Implementation operation crossed to document | 1 | tagged common-owner tuple foreign key |

#### 3.5 Reconcile the Executable Ownership Matrix

**File**: `test/store/migrations.test.ts`

**Changes**: Keep the four descriptor groups as the executable coverage structure and add one small reconciliation test that asserts the intended group sizes and total. This makes accidental case loss visible without duplicating all SQL or claiming sibling coverage.

```ts
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
```

Reconcile the named cases during review against this exact map:

| Bead acceptance subset | Executable evidence |
| --- | --- |
| Common operation/owner/role tags | 3 common vocabulary cases |
| Role and declared operation-kind agreement | 2 common role/kind inversion cases |
| Physical operation kind and existence | common physical-kind and missing-operation cases |
| Tagged fixed owner tags | 1 document and 1 implementation fixed-tag case |
| Exact tagged parents and bounds | 6 document plus 9 implementation parent/bound cases |
| Tagged/common tuple agreement | 2 document plus 2 implementation tuple cases |
| One role per tagged parent | 4 duplicate-role cases |
| Same-table physical-operation uniqueness | 2 same-table reuse cases |
| Cross-owner physical-operation uniqueness | 2 cross-owner reuse cases |
| Exact graph preservation and FK health | every descriptor passes through `expectIdentitySpineRejection` |
| Parent allocation and atomic gate | only this Bead's ownership subset is claimed; no child result releases the parent |

The reconciliation test checks completeness of this allocation, not database behavior by itself. The 36 individual real-SQLite tests remain the behavioral evidence.

#### 3.6 Apply Only a Demonstrated Local DDL Correction

**Files**: `src/store/migrations.ts`; `test/store/migrations.test.ts`

**Changes**: No planned migration edit. If a duplicate-role, same-table reuse, or cross-owner test succeeds after its setup is verified, correct only the demonstrated parent-plus-role key, `UNIQUE (operation_id)`, common `operation_id` key, or tagged tuple foreign key in `0011_qrspi_stage_runtime_layout`. Update the exact metadata/index assertion at `test/store/migrations.test.ts:2937-3020` or `3109-3212` and rerun the complete matrix.

Do not add a trigger, cross-table compatibility layer, store API, or runtime ownership lifecycle. If the required production change exceeds the accepted smallest local correction, stop and repeat scope review rather than broadening this plan.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Reconcile exactly 36 ownership tests: 7 common, 9 document, 12 implementation-step, and 8 duplicate/reuse cases.
- [ ] Map every named test to common vocabulary, role/kind pairing, physical identity, exact tagged parent, tagged common tuple, duplicate-role primary key, same-table operation uniqueness, or cross-owner common-spine uniqueness.
- [ ] Confirm duplicate-role cases use distinct valid operations so only the parent-plus-role key conflicts.
- [ ] Confirm same-table cases use a different valid parent and the original matching common tuple so only `UNIQUE (operation_id)` conflicts.
- [ ] Confirm cross-owner cases use a free tagged parent-plus-role and an operation not yet present in the destination table, so the common-owner tuple is the intended rejection boundary.
- [ ] Confirm every descriptor has a fresh database, complete tagged seed, valid setup before the snapshot, one rejected statement, exact eighteen-table equality, enabled foreign keys, and an empty foreign-key check.
- [ ] Inspect the final diff and confirm it adds no payload, reference, diagnostic, semantic, producer, publisher, progression, neighboring lifecycle, upgrade, legacy, or parent-release claim.
- [ ] If `src/store/migrations.ts` changed, tie every changed DDL line to a named previously failing allocated case and its exact metadata assertion; otherwise confirm migration 11 remains untouched.

**Implementation Note**: After completing this phase and all automated verification passes, pause for final human confirmation. Passing this plan completes only this Bead's bounded operation-ownership evidence and does not complete or release the parent migration gate.

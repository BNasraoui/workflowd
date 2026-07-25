---
task: workflowd-vs3.4.3.1.2.2.2.3-correct-and-prove-diagnostic-pair-completeness
type: plan
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 048eb0aa8621c0482181ba13141f5287ccfa6432
---

# Correct and Prove Diagnostic Pair Completeness Implementation Plan

## Overview

Close the demonstrated SQL-local nullable-pair gap in `qrspi_stage_revision_diagnostics` by adding exactly one equality check for the expected JSON/hash pair and one for the actual JSON/hash pair. Land those checks atomically with the complete allocated direct-SQL proof: 25 named fresh-graph rejection cases, two fresh-database positive absence controls, exact migration metadata assertions, and a named count-and-coverage reconciliation.

This is one phase because the DDL correction and its behavioral and metadata evidence are not independently complete. Every invalid statement must continue through the inherited `seedValidRuntimeIdentitySpine` and `expectIdentitySpineRejection` contract, which proves rejection, exact equality across the complete eighteen-table graph, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.

## Current State Analysis

Migration `0011_qrspi_stage_runtime_layout` already creates a strict diagnostic table with the complete allocated parent foreign key, bounded observed values and message, exact reason vocabulary, optional object-root expected and actual JSON, optional lowercase SHA-256 values, and one composite primary-key index. Its only demonstrated local shape gap is that each JSON and hash column is independently nullable, so a one-sided expected or actual pair currently passes.

The migration test fixture already contains one valid diagnostic whose expected and actual pairs are both complete. The shared runtime graph snapshot includes the diagnostic table, and the rejection helper already enforces the required fresh-graph non-mutation and foreign-key contract. The implementation therefore needs no fixture construction, new helper, trigger, application service, or migration number.

### Key Discoveries

- `src/store/migrations.ts:1052-1095` defines `qrspi_stage_revision_diagnostics`; the two pair checks belong after the existing four JSON/hash column checks and before timestamps and keys.
- `test/store/migrations.test.ts:665-716` defines the eighteen-table runtime graph and deterministic read order used for exact before/after comparison.
- `test/store/migrations.test.ts:800-1127` seeds the complete tagged graph. The diagnostic at lines 1059-1070 is attached to document StageRevision 1 and has valid non-null observed values, reason, message, two object JSON values, and two lowercase 64-character hashes.
- `test/store/migrations.test.ts:1129-1141` provides `expectIdentitySpineRejection`; every negative case must reuse it unchanged.
- Descriptor arrays followed by one fresh `runWithDatabase` test per descriptor are the established pattern at `test/store/migrations.test.ts:1183-1258`, `1260-1438`, and `1752-1771`.
- Updates against the seeded diagnostic isolate local shape checks without introducing a second diagnostic or a primary-key collision. Wrong-parent cases can update one primary-key coordinate to a locally valid but absent coordinate and rely on the existing composite foreign key.
- `test/store/migrations.test.ts:3400-3826` already locks diagnostic columns, strictness, composite foreign keys, reason literals, JSON/hash snippets, and all related tagged-layout metadata. The diagnostic DDL inventory is the exact place to add the two equality snippets.
- `test/store/migrations.test.ts:3828-3931` already requires the diagnostic table to have only its composite primary-key index, while `test/store/migrations.test.ts:3933-3966` separately proves no runtime trigger exists. Neither assertion needs structural change.
- `test/store/migrations.test.ts:2424-2436` demonstrates a compact named matrix reconciliation using descriptor lengths and exact expected counts.
- The accepted ancestor Design assigns local SQL shape to strict checks and composite foreign keys while reserving semantic identity, canonical hashes, cross-row behavior, and progression for decoded store transactions. It explicitly prohibits SQL progression triggers.

## Desired End State

- Migration `0011_qrspi_stage_runtime_layout` adds exactly `CHECK ((expected_json IS NULL) = (expected_sha256 IS NULL))` and `CHECK ((actual_json IS NULL) = (actual_sha256 IS NULL))` to `qrspi_stage_revision_diagnostics`.
- Four parent-identity cases reject an absent workflow, Generation, stage, or revision coordinate while every diagnostic value remains valid.
- Seven literal/bound cases reject an unsupported reason, empty and 2,001-character messages, empty and 65-character observed kinds, and empty and 65-character observed states.
- Four JSON cases reject malformed and array-root expected JSON and malformed and array-root actual JSON.
- Six hash cases separately reject wrong-length, uppercase, and non-hex expected SHA-256 values and the same three actual SHA-256 values while the paired JSON remains present and valid.
- Four one-sided-pair cases reject expected JSON without hash, expected hash without JSON, actual JSON without hash, and actual hash without JSON.
- Each of the 25 invalid statements runs in its own fresh database after the complete seed and proves exact graph non-mutation, enabled foreign keys, and no foreign-key violations through the unchanged helper.
- Two separate positive tests prove a wholly absent expected pair with a complete actual pair and a wholly absent actual pair with a complete expected pair. Each reads back all four fields exactly and proves clean foreign-key state.
- Exact metadata includes both equality checks while preserving the diagnostic columns, strict status, composite StageRevision foreign key, reason vocabulary, object-JSON checks, lowercase hash checks, primary-key-only index inventory, and no-trigger assertion.
- A named reconciliation locks `4 + 7 + 4 + 6 + 4 = 25` rejections and `2` positive controls and records that executable coverage belongs only to immediate-parent acceptance criteria 3 and 4 and the diagnostic portions of criteria 5 and 6.
- Passing this plan does not claim sibling reference coverage, criterion 7 parent release, canonical JSON/hash semantics, typed diagnostics, quarantine, or any cross-row behavior.

## What We're NOT Doing

- Requiring either expected or actual pair; both pairs remain nullable as complete units.
- Comparing expected values with actual values or proving canonical JSON/hash equality.
- Adding triggers, cross-row rules, typed diagnostic decoding, quarantine transitions, store APIs, or runtime behavior.
- Extending or duplicating `seedValidRuntimeIdentitySpine`, `readRuntimeGraph`, or `expectIdentitySpineRejection`.
- Adding artifact-reference, implementation-commit-reference, checkpoint, payload, or operation-owner rejection cases owned by sibling outcomes.
- Adding a new migration or changing any production table, column, key, index, or check outside the two authorized diagnostic equality checks.
- Claiming completion or release of immediate parent `workflowd-vs3.4.3.1.2.2.2` or its parent migration gate.

## Implementation Approach

Make the smallest production edit first: append the two pair-equality table checks to the existing diagnostic DDL, without changing individual JSON/hash checks or nullability. Then add five explicitly named diagnostic descriptor groups beside the inherited fixture tests. Prefer failed `UPDATE`s against the seeded diagnostic so each case mutates exactly its named coordinate or field and retains every other valid fixture value.

Combine the five groups only for the execution loop. This preserves reviewable group identities and count reconciliation while ensuring every descriptor becomes an independent Bun test with a fresh database. Add the two positive controls as their own descriptor-driven tests, but execute each in a separate `runWithDatabase`, update one whole pair to `NULL`, and select all four pair columns for exact comparison.

Finally, extend the existing diagnostic DDL snippet inventory and add a named coverage reconciliation. Do not modify the index or no-trigger tests: their existing exact assertions are preservation evidence and should continue passing unchanged.

---

## Phase 1: Correct and Prove Diagnostic Pair Completeness

### Overview

Land the two local DDL checks and all allocated negative, positive, metadata, and coverage evidence as one independently verifiable slice. The phase is complete only when all 25 contradictions fail without mutating the complete graph, both allowed asymmetric absence shapes succeed, and exact schema metadata agrees with the production DDL.

### Changes Required

#### 1.1 Add Only the Two Diagnostic Pair Checks

**File**: `src/store/migrations.ts`

**Changes**: In `qrspiStageRuntimeLayout`, update `qrspi_stage_revision_diagnostics` around lines 1068-1089. Keep the individual optional object-JSON and lowercase SHA-256 checks unchanged, then add the two table-level equality checks immediately after them and before `created_at`.

```diff
       actual_sha256 TEXT CHECK (
         actual_sha256 IS NULL OR (
           length(actual_sha256) = 64 AND actual_sha256 NOT GLOB '*[^0-9a-f]*'
         )
       ),
+      CHECK ((expected_json IS NULL) = (expected_sha256 IS NULL)),
+      CHECK ((actual_json IS NULL) = (actual_sha256 IS NULL)),
       created_at TEXT NOT NULL,
```

Do not add `NOT NULL`, a check requiring either pair, an expected-versus-actual comparison, a canonical hash check, a trigger, or another migration. The existing complete fixture row must remain valid after this DDL change.

#### 1.2 Add Four Wrong-Parent Diagnostic Descriptors

**File**: `test/store/migrations.test.ts`

**Changes**: After the complete fixture and shared rejection helper, add `diagnosticParentIdentityCases` with exactly four named failed updates. Each update changes one composite identity coordinate of the seeded diagnostic to a locally valid absent value:

| Case | Mutated coordinate | Locally valid absent value |
| --- | --- | --- |
| Wrong workflow | `workflow_id` | `workflow-runtime-identity-absent` |
| Wrong Generation | `generation` | `2` |
| Wrong stage | `stage_key` | `stage-runtime-identity-absent` |
| Wrong revision | `stage_revision` | `5` |

Generation 2 exists elsewhere in the complete graph, while the stage and workflow values are nonempty, locally valid absent identifiers. No common StageRevision matches any full mutated diagnostic identity. This ensures the composite StageRevision foreign key, not a local bound or primary-key collision, is the rejecting authority.

```ts
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
```

Keep the interpolation limited to the four hard-coded assignment names in the local descriptor array. Bind every value and every row-selector coordinate as parameters.

#### 1.3 Add Seven Diagnostic Literal and Bound Descriptors

**File**: `test/store/migrations.test.ts`

**Changes**: Add `diagnosticLiteralAndBoundCases` as explicit names, assignments, and values. Cover exactly:

- Unsupported `reason`, using a nonempty literal such as `future_reason`.
- Empty `message`.
- A 2,001-character `message`.
- Empty `observed_kind`.
- A 65-character `observed_kind`.
- Empty `observed_state`.
- A 65-character `observed_state`.

```ts
const diagnosticLiteralAndBoundCases = [
  { name: "rejects an unsupported diagnostic reason", assignment: "reason", value: "future_reason" },
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
      [testCase.value, runtimeFixture.workflowId, 1,
        runtimeFixture.documentStageKey, runtimeFixture.historicalRevision],
    ),
}))
```

Do not add a rejection for `NULL` observed kind or state. Both columns intentionally allow `NULL`; the fixture's non-null values and the exact column metadata preserve that nullable shape.

#### 1.4 Add Four JSON and Six Hash-Shape Descriptors

**File**: `test/store/migrations.test.ts`

**Changes**: Add `diagnosticJsonCases` with malformed and array-root values for each JSON field. Use failed updates against the complete seeded pair so the paired hash remains present and valid:

```ts
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
```

Add `diagnosticHashCases` with three separate non-null failures per hash field:

```ts
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
```

Keep `toDiagnosticFieldUpdate` local to the diagnostic descriptor block and pass it only descriptors whose assignment names are hard-coded in the JSON and hash arrays. Do not add a module-level helper or alter the shared rejection contract.

Malformed and wrong-root JSON must remain distinct cases. Wrong-length, uppercase, and non-hex SHA-256 must remain distinct non-null cases so nullable SQLite `CHECK` behavior cannot make the intended predicate ambiguous.

#### 1.5 Add All Four One-Sided Pair Descriptors

**File**: `test/store/migrations.test.ts`

**Changes**: Add `diagnosticOneSidedPairCases` using the seeded diagnostic, whose two pairs start complete. Clear exactly one member per case:

```ts
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
      [runtimeFixture.workflowId, 1,
        runtimeFixture.documentStageKey, runtimeFixture.historicalRevision],
    ),
}))
```

These four cases are the direct behavioral evidence for the two new production checks. Do not combine two assignments in one negative case, because a wholly absent pair is valid and belongs to the positive controls.

#### 1.6 Execute All 25 Rejections Through the Existing Fresh-Graph Contract

**File**: `test/store/migrations.test.ts`

**Changes**: Combine the five descriptor groups only for iteration and execute one independent Bun test per descriptor:

```ts
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
```

This loop must produce 25 separately named tests, not 25 statements in one database. Do not add setup before the helper after seeding: each descriptor's single failed statement must be the only attempted graph mutation after the valid baseline is captured.

#### 1.7 Prove Both Allowed Asymmetric Absence Shapes

**File**: `test/store/migrations.test.ts`

**Changes**: Add two named positive controls. Each must run in its own fresh database, seed the complete graph, clear both members of exactly one pair, select all four pair columns from the same diagnostic, and inspect foreign-key state after the successful update.

```ts
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
          [runtimeFixture.workflowId, 1,
            runtimeFixture.documentStageKey, runtimeFixture.historicalRevision],
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
```

Keep the assignment strings restricted to the two literal complete-pair clear operations. These tests prove neither pair is required and that the opposite complete pair remains valid; they do not compare expected and actual content semantically.

#### 1.8 Lock the Two Checks in Exact Tagged-Layout Metadata

**File**: `test/store/migrations.test.ts`

**Changes**: In the `qrspi_stage_revision_diagnostics.ddl` inventory inside `creates the exact tagged payload, reference, diagnostic, and operation layout` around lines 3623-3654, add the two compact snippets corresponding exactly to the production checks:

```diff
           "length(actual_sha256) = 64",
           "actual_sha256 NOT GLOB '*[^0-9a-f]*'",
+          "(expected_json IS NULL) = (expected_sha256 IS NULL)",
+          "(actual_json IS NULL) = (actual_sha256 IS NULL)",
         ],
```

Leave the expected diagnostic column inventory, strict-table check, grouped composite foreign key, exact reason-literal extraction, and JSON/hash snippets unchanged. Leave `installs the exact runtime indexes` unchanged so it continues to prove the diagnostic has only `sqlite_autoindex_qrspi_stage_revision_diagnostics_1` as its composite primary-key index. Leave `installs no runtime facts, triggers, or executable claim indexes` unchanged so no trigger remains part of this slice.

#### 1.9 Add Named Matrix and Parent-Coverage Reconciliation

**File**: `test/store/migrations.test.ts`

**Changes**: Add one named executable reconciliation after the diagnostic tests. Lock each group count, the total rejection count, positive-control count, and the bounded immediate-parent allocation:

```ts
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
```

Keep immediate-parent criterion 7 and the broader migration-gate release out of the executable allocation array. They are delivery boundaries, not SQL behavior. The test name and expected allocation must not imply artifact-reference/checkpoint sibling coverage, typed diagnostics, or quarantine.

### Success Criteria

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Inspect `src/store/migrations.ts` and confirm the only production changes are the two exact equality checks in `qrspi_stage_revision_diagnostics`.
- [ ] Reconcile exactly 25 named negative tests: 4 parent identity, 7 literal/bound, 4 JSON, 6 hash, and 4 one-sided-pair cases.
- [ ] Confirm every negative descriptor starts from a fresh `runWithDatabase`, calls the unchanged complete seed, attempts exactly one invalid update, and delegates rejection, eighteen-table equality, foreign-key enablement, and `foreign_key_check` cleanliness to `expectIdentitySpineRejection`.
- [ ] Confirm each parent case changes only one locally valid coordinate and each field case changes only its named value while every other diagnostic field remains valid.
- [ ] Confirm malformed and array-root JSON are distinct, and wrong-length, uppercase, and non-hex hashes are three distinct non-null cases for both expected and actual fields.
- [ ] Confirm all four one-sided combinations are rejected and the two positive controls each clear one whole pair, preserve the opposite complete pair, read back all four values exactly, and retain clean foreign keys.
- [ ] Compare production DDL with the exact metadata snippets and verify the existing columns, strictness, composite foreign key, reason vocabulary, JSON/hash checks, sole primary-key index, and no-trigger assertion remain intact.
- [ ] Inspect the final migration and test diff together and confirm it adds no required pair, expected-versus-actual comparison, canonical semantic, typed diagnostic, quarantine behavior, cross-row rule, fixture extension, sibling reference case, or parent-release claim.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation. Passing this plan completes only this Bead's bounded diagnostic SQL-local correction and evidence; it does not complete or release any parent migration gate.

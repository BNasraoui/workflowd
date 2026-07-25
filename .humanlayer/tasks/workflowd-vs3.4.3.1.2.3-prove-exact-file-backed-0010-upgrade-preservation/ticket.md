# Prove exact file-backed 0010 upgrade preservation

**Bead:** `workflowd-vs3.4.3.1.2.3`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Populate a real file database through `0010`, close it, reopen the same file through a fresh current layer, and prove complete Generation and WorkflowOperation equality after migration. The upgrade must preserve null runtime cursors, advance the migration ledger exactly once, leave all twelve runtime tables empty, retain foreign-key integrity, infer no runtime authority, and clean up temporary files even on failure.

This child depends only on the completed strict inactive shared runtime layout and is implementation-independent of the two SQL rejection children. It owns the file-lifecycle and exact-row-preservation portion of the mandatory atomic migration release gate for workflowd-vs3.4.3.1.2.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.2-prove-shared-runtime-sql-invariants-and-upgrade-preservation/01-structure-outline-sql-invariants-upgrade-preservation.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.2-prove-shared-runtime-sql-invariants-and-upgrade-preservation/04-structure-scope-review-r1.md`

## Out of Scope

- Identity-spine and tagged payload SQL rejection matrices owned by the other children.
- Typed aggregate Schemas, store create/read behavior, runtime APIs, or semantic hash recomputation.
- Runtime allocation, transition, claim, progression, bootstrap, quarantine, inferred legacy conversion, or neighboring lifecycle behavior.
- Editing migrations `0001` through `0010`, weakening append-only `0011`, or introducing runtime rows during upgrade.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- A real file database built through `runStoreMigrationsThrough0010` contains diverse Generation and WorkflowOperation rows covering identities, states, currentness, retry lineage, nullable lease/effect/output fields, terminal metadata, JSON values, hashes, and timestamps.
- After the historical layer closes and a fresh current layer migrates the same file, complete deterministically ordered `SELECT *` snapshots prove every shipped Generation and WorkflowOperation identity and pre-existing column value is exactly unchanged.
- The migration ledger advances exactly once to `0011`, every Generation runtime cursor remains null, every original `generation_format` is preserved, all twelve runtime tables remain empty, and `PRAGMA foreign_key_check` reports no violations.
- Temporary files are removed after success or failure, and this child covers acceptance criteria 2 and 3 plus the preservation portion of criterion 4/A1: append-only `0011`, retry/currentness/nullable fields, zero legacy conversion, zero runtime authority, FK/index fidelity, and demonstrated corrections.

## Scenarios

### Scenario: Preserve every shipped value across a fresh layer

**Given** a populated file database migrated only through `0010` and then closed
**When** a fresh layer opens the same file and applies current migrations
**Then** every Generation and WorkflowOperation identity and pre-existing column value is exactly unchanged

### Scenario: Infer no runtime authority

**Given** the populated database has crossed the `0010` to `0011` boundary
**When** the runtime cursors, migration ledger, foreign keys, and all twelve runtime tables are inspected
**Then** the cursors are null, the ledger advanced once, the runtime tables are empty, foreign keys are valid, and no legacy fact was converted

### Scenario: Keep the migration release gate atomic

**Given** this exact upgrade-preservation suite passes
**When** the SQL rejection children under workflowd-vs3.4.3.1.2 have not both passed
**Then** the parent migration outcome is not considered releasable

## Notes

Recursive scope outcome T3. Dependency: completed layout child `workflowd-vs3.4.3.1.1`; independent of T1 and T2 implementation. Primary files: `test/store/migrations.test.ts`; conditional `src/store/migrations.ts`. Provisional changed lines: low 160, likely 245, high 380. Exact acceptance/control/risk coverage: Acceptance criteria 2 and 3 and the preservation portion of criterion 4/A1; append-only `0011`, every shipped value and identity, retry/currentness/nullable fields, format preservation, zero legacy conversion, zero runtime authority, FK/index fidelity, and any correction exposed by the upgrade proof. Production contingency included: 0/5/40. Risks retained: file lifecycle and cleanup, accidental shipped-value rewrite, migration-ledger drift, inferred runtime authority, SQLite reconstruction, FK/index fidelity, and the smallest demonstrated `0011` correction. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan. The parent release gate remains atomic and cannot be completed or released until all three child outcomes pass together.

## Dependencies

- `workflowd-vs3.4.3.1.2`: Prove shared runtime SQL invariants and upgrade preservation (parent-child)
- `workflowd-vs3.4.3.1.1`: Install the strict inactive shared runtime layout (blocks)


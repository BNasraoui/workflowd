# Prove runtime identity-spine SQL rejection

**Bead:** `workflowd-vs3.4.3.1.2.1`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Build the complete valid runtime graph and deterministic unchanged-graph harness, then prove that Generation cursor, StageRun currentness, common revision identity, format/state/kind tags, owner-crossing identity, same-run pointers, and identity ordinals reject SQL-local contradictions. Each rejected statement must leave the seeded valid graph unchanged and preserve foreign-key integrity.

This child owns the shared fixture and snapshot harness consumed by the tagged payload rejection child. It depends on the completed strict inactive shared runtime layout and contributes one mandatory part of the atomic migration release gate owned by workflowd-vs3.4.3.1.2.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.2-prove-shared-runtime-sql-invariants-and-upgrade-preservation/01-structure-outline-sql-invariants-upgrade-preservation.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.2-prove-shared-runtime-sql-invariants-and-upgrade-preservation/04-structure-scope-review-r1.md`

## Out of Scope

- Tagged payload, reference, JSON/hash, nullable-shape, operation-role, and ownership rejection cases owned by the following child.
- File-backed `0010` upgrade-preservation and zero-inference proof owned by the independent upgrade child.
- Typed aggregate Schemas, store create/read behavior, semantic hash recomputation, or cross-row semantic completeness.
- Runtime allocation, transition, claim, progression, bootstrap, quarantine, legacy conversion, or neighboring lifecycle behavior.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- A reusable real-SQLite fixture creates the complete valid runtime graph required to exercise the Generation cursor, StageRun currentness, common StageRevision identity, owner-crossing identity, and same-run pointers.
- A deterministic snapshot harness proves every allocated identity-spine contradiction is rejected, the complete valid graph remains unchanged, and `PRAGMA foreign_key_check` reports no violations.
- Direct SQL rejects unsupported Generation formats; invalid run, revision-kind, and revision-state tags; half-populated Generation cursors; invalid run, revision, and pointer ordinals; duplicate current runs; duplicate owner-crossing keys; and pending, published, or accepted pointers to another run.
- This child covers acceptance criterion 1 for identity-spine cases and retains the same-Generation cursor, one-current-run, owner-crossing uniqueness, same-run pointer, append-only history, format/cursor guard, and demonstrated-correction controls.

## Scenarios

### Scenario: Reject an identity-spine contradiction

**Given** a complete valid runtime graph in real SQLite
**When** direct SQL attempts one allocated cursor, currentness, identity, tag, pointer, or ordinal contradiction
**Then** SQLite rejects the statement, the complete graph is unchanged, and foreign-key integrity remains intact

### Scenario: Preserve the shared harness boundary

**Given** the valid graph and deterministic snapshot harness
**When** later tagged invariant tests consume and extend the fixture
**Then** this child remains the sole owner of the shared fixture and snapshot foundation without claiming tagged-case coverage

### Scenario: Keep the migration release gate atomic

**Given** this identity-spine rejection suite passes
**When** the other children under workflowd-vs3.4.3.1.2 have not all passed
**Then** the parent migration outcome is not considered releasable

## Notes

Recursive scope outcome T1. Dependency: completed layout child `workflowd-vs3.4.3.1.1`. Primary files: `test/store/migrations.test.ts`; conditional `src/store/migrations.ts`. Provisional changed lines: low 380, likely 575, high 860. Exact acceptance/control/risk coverage: Acceptance criterion 1 for identity-spine cases; unchanged valid graph and `PRAGMA foreign_key_check`; same-Generation cursor, one-current-run, owner-crossing uniqueness, same-run pointers, append-only history, format/cursor guards, and any correction exposed by these cases. Owns the shared fixture and snapshot harness. Production contingency included: 0/15/80. Risks retained: SQL-local identity-spine enforcement, graph mutation after rejected statements, foreign-key integrity, append-only preservation, and the smallest demonstrated `0011` correction. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan. The parent release gate remains atomic and cannot be completed or released until all three child outcomes pass together.

## Dependencies

- `workflowd-vs3.4.3.1.1`: Install the strict inactive shared runtime layout (blocks)
- `workflowd-vs3.4.3.1.2`: Prove shared runtime SQL invariants and upgrade preservation (parent-child)


# Prove tagged payload, reference, and operation-ownership SQL rejection

**Bead:** `workflowd-vs3.4.3.1.2.2`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Extend the complete valid runtime fixture through every tagged child and prove that wrong variants, malformed JSON and hash shapes, nullable pairs and triads, reference and diagnostic ordinals, owner-role/kind disagreement, duplicate roles, and cross-owner physical-operation reuse are rejected by direct SQL. Every rejected statement must leave the valid graph unchanged and preserve foreign-key integrity.

This child consumes and extends the fixture and snapshot harness owned by workflowd-vs3.4.3.1.2.1. It completes the tagged payload, reference, diagnostic, and operation-ownership portion of the mandatory SQL-local migration release-gate proof.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.2-prove-shared-runtime-sql-invariants-and-upgrade-preservation/01-structure-outline-sql-invariants-upgrade-preservation.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.2-prove-shared-runtime-sql-invariants-and-upgrade-preservation/04-structure-scope-review-r1.md`

## Out of Scope

- Shared fixture and identity-spine rejection ownership assigned to workflowd-vs3.4.3.1.2.1.
- File-backed `0010` upgrade-preservation and zero-inference proof owned by the independent upgrade child.
- Typed aggregate Schemas, store create/read behavior, semantic hash recomputation, triggers, or cross-row semantic completeness assigned to later typed transactions and strict reads.
- Runtime allocation, transition, claim, progression, bootstrap, quarantine, legacy conversion, or neighboring lifecycle behavior.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- The valid fixture extends through document and implementation payloads, implementation steps, immutable references, diagnostics, physical WorkflowOperations, the common operation-owner spine, and both tagged ownership variants.
- Direct SQL rejects wrong fixed payload and owner tags; cross-variant children; wrong parent identities; malformed or wrong-root JSON; forbidden empty collections; one-sided nullable JSON/hash pairs and step triads; malformed runtime hashes; invalid reference, checkpoint, diagnostic, step, and ownership ordinals; owner-role/kind disagreement; duplicate owner roles; and reuse of one physical WorkflowOperation across document and step owners.
- Every case proves the complete valid graph is unchanged and `PRAGMA foreign_key_check` reports no violations.
- This child covers the remainder of acceptance criterion 1 and the SQL-local portion of A3 for tagged-table ownership, sibling schema completeness, immutable-reference shapes, diagnostics, operation hooks, role uniqueness, physical-operation uniqueness, and demonstrated corrections.

## Scenarios

### Scenario: Reject a tagged or ownership contradiction

**Given** the complete valid runtime graph with every tagged child and ownership seam
**When** direct SQL attempts one allocated variant, JSON, hash, nullable-shape, ordinal, role, or physical-operation contradiction
**Then** SQLite rejects the statement, the complete graph is unchanged, and foreign-key integrity remains intact

### Scenario: Distinguish SQL-local from semantic completeness

**Given** the completed rejection matrix
**When** its coverage is reconciled against the shared runtime schema
**Then** it claims only SQL-local guarantees and leaves coordinated child completeness to later typed transactions and strict reads

### Scenario: Keep the migration release gate atomic

**Given** this tagged rejection suite passes
**When** the other children under workflowd-vs3.4.3.1.2 have not all passed
**Then** the parent migration outcome is not considered releasable

## Notes

Recursive scope outcome T2. Dependency: workflowd-vs3.4.3.1.2.1. Primary files: `test/store/migrations.test.ts`; conditional `src/store/migrations.ts`. Provisional changed lines: low 300, likely 480, high 740. Exact acceptance/control/risk coverage: Remainder of acceptance criterion 1; SQL-local portion of A3 for tagged-table ownership, sibling schema completeness, immutable-reference shapes, diagnostics, operation hooks, role uniqueness, physical-operation uniqueness, and any correction exposed by these cases. Every case retains unchanged-graph and foreign-key proof. Production contingency included: 0/10/60. Risks retained: cross-variant ownership, incomplete sibling-schema evidence, malformed local shapes, contradictory operation authority, physical-operation reuse, graph mutation after rejection, and the smallest demonstrated `0011` correction. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan. The parent release gate remains atomic and cannot be completed or released until all three child outcomes pass together.

## Dependencies

- `workflowd-vs3.4.3.1.2.1`: Prove runtime identity-spine SQL rejection (blocks)
- `workflowd-vs3.4.3.1.2`: Prove shared runtime SQL invariants and upgrade preservation (parent-child)


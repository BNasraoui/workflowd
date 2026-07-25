# Reject immutable-reference and diagnostic contradictions

**Bead:** `workflowd-vs3.4.3.1.2.2.2`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Prove by direct SQL that artifact references, implementation commit references, implementation checkpoints, and revision diagnostics reject every allocated local parent, ordinal, repository, collection, JSON, hash, nullable-pair, literal, and bound contradiction. Close the demonstrated diagnostic expected/actual JSON/hash pairing gap with the smallest local `0011_qrspi_stage_runtime_layout` correction and lock that correction with exact metadata and behavioral evidence.

This child consumes the complete tagged fixture owned by the payload child. It contributes the immutable-reference and diagnostic portion of the parent SQL-local release-gate proof but is not separately releasable and does not claim semantic identity or quarantine behavior.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2-prove-tagged-payload-reference-and-operation-ownership-sql-rejec/01-structure-outline-tagged-sql-rejection.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2-prove-tagged-payload-reference-and-operation-ownership-sql-rejec/04-structure-scope-review-r1.md`

## Out of Scope

- Fixture extension and tagged payload, source-set, pair, triad, and step-bound rejection owned by the payload child.
- Common and tagged operation-owner rejection and final ownership reconciliation owned by the operation-ownership child.
- Canonical hash recomputation, collection-content semantics, semantic reference identity, coordinated child completeness, typed diagnostics, quarantine, triggers, runtime behavior, upgrade preservation, or neighboring lifecycles.
- Any production change beyond the demonstrated diagnostic pair checks or another smallest local correction directly exposed by an allocated case.
- Completion or release of the parent migration gate before all allocated child outcomes and parent integration reconciliation pass.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- Direct SQL rejects artifact references with the wrong document-versus-implementation parent identity; wrong workflow, Generation, stage, or revision identity; empty or malformed repository fields or full names; empty paths or media types; and invalid commit, blob, or content hash shapes.
- Direct SQL rejects implementation commit references and checkpoints with wrong implementation-revision or step parents; lower or upper invalid positions; empty checkpoint identity; malformed repository fields or Git hashes; malformed, wrong-root, or forbidden-empty required collection JSON; and invalid collection, changed-path, or prepared-evidence SHA-256 shapes.
- Direct SQL rejects diagnostics with wrong revision identity; unsupported reason; empty or over-bound message; invalid observed-kind or observed-state lengths; malformed or wrong-root expected/actual JSON; invalid expected/actual hashes; and every one-sided expected JSON/hash or actual JSON/hash pair.
- The smallest demonstrated `0011_qrspi_stage_runtime_layout` correction pairs `expected_json` with `expected_sha256` and `actual_json` with `actual_sha256` without requiring either pair, adding triggers, or asserting cross-row or canonical semantics; exact tagged-layout metadata assertions lock both checks.
- Every invalid statement uses a fresh complete graph and proves rejection, exact before/after graph equality, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.
- Coverage remains limited to the ticket reference/checkpoint/diagnostic subset, the demonstrated correction, SQL-local D1/D4, C1/V1, R1, and the local diagnostic shape relevant to R4 without claiming quarantine.
- Passing this child alone does not complete or release the parent migration gate.

## Scenarios

### Scenario: Reject an immutable-reference contradiction

**Given** the complete tagged runtime graph with valid artifact, commit, and checkpoint references
**When** direct SQL attempts one allocated parent, ordinal, repository, collection, JSON, or hash contradiction
**Then** SQLite rejects the statement, the complete graph is unchanged, and foreign-key integrity remains intact

### Scenario: Correct and prove diagnostic pair completeness

**Given** the current diagnostic table permits a one-sided expected or actual JSON/hash value
**When** the local pair checks are added and each one-sided case is attempted
**Then** SQLite rejects each case while allowing either complete pair to remain absent, and exact metadata evidence locks the checks

### Scenario: Preserve semantic and release boundaries

**Given** the reference and diagnostic matrix passes
**When** its guarantees are reconciled
**Then** it claims no canonical hash, collection-content, semantic reference, typed diagnostic, or quarantine behavior, and the parent gate remains incomplete until every allocated child and parent reconciliation pass

## Notes

Recursive scope outcome T2. Dependency: T1 complete fixture (`workflowd-vs3.4.3.1.2.2.1`). Primary files: `test/store/migrations.test.ts`; `src/store/migrations.ts`. Provisional changed lines: low 306, likely 462, high 685. Exact acceptance/control/risk coverage: ticket AC reference/checkpoint/diagnostic parent, ordinal, repository, collection, JSON, hash, pair, literal, and bound subset; demonstrated correction; unchanged graph/FK proof; SQL-local D1/D4, C1/V1, R1, and the local diagnostic shape relevant to R4 without claiming quarantine. Risks retained: wrong reference authority, malformed repository or immutable-reference shapes, invalid collections and ordinals, unsupported diagnostic literals or bounds, one-sided diagnostic pairs, metadata drift, graph mutation after rejection, and overclaiming quarantine or semantic guarantees. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan. The parent retains shared integration accounting and the atomic completion condition.

## Dependencies

- `workflowd-vs3.4.3.1.2.2`: Prove tagged payload, reference, and operation-ownership SQL rejection (parent-child)
- `workflowd-vs3.4.3.1.2.2.1`: Complete tagged graph and reject payload contradictions (blocks)


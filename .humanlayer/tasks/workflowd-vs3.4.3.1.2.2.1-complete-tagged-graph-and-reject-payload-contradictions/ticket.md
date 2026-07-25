# Complete tagged graph and reject payload contradictions

**Bead:** `workflowd-vs3.4.3.1.2.2.1`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Extend the inherited identity-spine fixture into a valid complete tagged runtime graph, then prove by direct SQL that fixed-tag, cross-variant, wrong-parent, source-set, payload-shape, nullable-pair, implementation-step-triad, and step-bound contradictions are rejected. Every invalid statement must run against a fresh otherwise-valid graph, leave the complete graph unchanged, and preserve foreign-key integrity.

This child owns the fixture extension consumed by the sibling reference/diagnostic and operation-ownership children. It contributes the payload/tag/identity portion of the parent SQL-local release-gate proof but is not separately releasable.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2-prove-tagged-payload-reference-and-operation-ownership-sql-rejec/01-structure-outline-tagged-sql-rejection.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2-prove-tagged-payload-reference-and-operation-ownership-sql-rejec/04-structure-scope-review-r1.md`

## Out of Scope

- Immutable-reference and diagnostic rejection cases and the diagnostic nullable-pair correction owned by the following reference/diagnostic child.
- Common and tagged operation-owner rejection and final ownership reconciliation owned by the operation-ownership child.
- Typed aggregate decoding, canonical hash recomputation, coordinated child completeness, transition semantics, triggers, runtime behavior, upgrade preservation, legacy conversion, or neighboring lifecycles.
- Completion or release of the parent migration gate before all allocated child outcomes and parent integration reconciliation pass.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- The inherited real-SQLite fixture extends through valid document and implementation payloads, an ordered implementation step, artifact and commit references, a checkpoint, a diagnostic, the required physical operations, the common operation-owner spine, and both tagged owner variants, with the complete row inventory and empty `PRAGMA foreign_key_check` proved after seeding.
- Direct SQL rejects wrong document and implementation fixed tags; cross-variant payloads and steps; otherwise-valid tagged children attached to the wrong workflow, Generation, stage, revision, or step identity; malformed or wrong-root payload and source-set JSON; invalid local SHA-256 shapes; one-sided document and implementation JSON/hash pairs; every incomplete or invalid implementation-step JSON/hash/`final` triad; and lower or upper step positions outside the allocated bounds.
- Every invalid statement uses the inherited rejection helper against a fresh complete graph and proves rejection, exact before/after graph equality, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.
- Coverage remains limited to the ticket fixture-extension and payload/tag/identity/JSON/hash/pair/triad/ordinal subset and its SQL-local D1/D4, C1/V1, and R1 contribution; D10 exclusions and the semantic-completeness boundary remain intact.
- Passing this child alone does not complete or release the parent migration gate.

## Scenarios

### Scenario: Reject a tagged payload contradiction

**Given** a fresh valid complete tagged runtime graph
**When** direct SQL attempts one allocated fixed-tag, cross-variant, wrong-parent, source-set, JSON, hash, nullable-pair, implementation-step-triad, or step-bound contradiction
**Then** SQLite rejects the statement, the complete graph is unchanged, foreign keys remain enabled, and `PRAGMA foreign_key_check` is empty

### Scenario: Preserve the shared fixture frontier

**Given** the completed tagged fixture and rejection harness
**When** the reference/diagnostic or operation-ownership child begins its own Structure work
**Then** it can consume this fixture without duplicating ownership or expanding this child beyond payload/tag constraints

### Scenario: Preserve the SQL-local and atomic-gate boundaries

**Given** this child passes
**When** semantic completeness or parent release is evaluated
**Then** canonical semantics remain deferred and the parent gate remains incomplete until every allocated child and parent reconciliation pass

## Notes

Recursive scope outcome T1. Dependency: predecessor Bead `workflowd-vs3.4.3.1.2.1`; no proposed-child dependency. Primary file: `test/store/migrations.test.ts`. Provisional changed lines: low 390, likely 580, high 840. Exact acceptance/control/risk coverage: ticket AC fixture extension; direct-SQL payload/tag/identity/JSON/hash/pair/triad/ordinal subset; every case unchanged graph and foreign-key integrity; SQL-local D1/D4, C1/V1, and R1; preserve D10 exclusions and the semantic-boundary scenario. Risks retained: incomplete tagged fixture evidence, fixed-tag and cross-variant acceptance, wrong-parent identity, malformed local source-set or payload shapes, incomplete nullable pairs or step triads, invalid bounds, graph mutation after rejection, and foreign-key drift. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan. The parent retains shared integration accounting, final named-case reconciliation, complete row inventory, suite-wide graph/FK assertions, and the atomic completion condition.

## Dependencies

- `workflowd-vs3.4.3.1.2.2`: Prove tagged payload, reference, and operation-ownership SQL rejection (parent-child)
- `workflowd-vs3.4.3.1.2.1`: Prove runtime identity-spine SQL rejection (blocks)


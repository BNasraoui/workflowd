# Correct and prove diagnostic pair completeness

**Bead:** `workflowd-vs3.4.3.1.2.2.2.3`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Add the two local diagnostic nullable-pair checks and prove by direct SQL all allocated diagnostic parent, literal, bound, JSON, hash, absent-pair, and one-sided-pair behavior against a fresh complete tagged runtime graph. Land the production checks, rejection cases, positive absence controls, exact tagged-layout metadata assertions, and final named ticket coverage reconciliation atomically.

This child consumes the completed fixture and rejection harness from `workflowd-vs3.4.3.1.2.2.1`; it does not own fixture construction and has no dependency on its sibling outcomes. Its primary files are `src/store/migrations.ts` and `test/store/migrations.test.ts`. Its provisional estimate is low 186, likely 275, high 376 changed lines.

This outcome contributes the diagnostic portion of the parent SQL-local release-gate proof but is not separately releasable and cannot release the parent gate.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2.2-reject-immutable-reference-and-diagnostic-contradictions/01-structure-outline-immutable-reference-diagnostics.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2.2-reject-immutable-reference-and-diagnostic-contradictions/04-structure-scope-review-r1.md`

## Out of Scope

- Artifact-reference and implementation commit/checkpoint rejection allocated to sibling outcomes.
- Fixture construction or extension owned by `workflowd-vs3.4.3.1.2.2.1`.
- Requiring either diagnostic pair, adding triggers, comparing expected with actual, canonical hash or JSON semantics, typed diagnostics, quarantine behavior, or cross-row semantics.
- Production changes beyond `CHECK ((expected_json IS NULL) = (expected_sha256 IS NULL))` and `CHECK ((actual_json IS NULL) = (actual_sha256 IS NULL))`.
- Completion or release of the parent migration gate before every allocated child and parent integration reconciliation pass.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- Direct SQL rejects diagnostics with wrong workflow, Generation, stage, or revision identity; unsupported reason; empty or over-bound message; and empty or over-bound observed-kind or observed-state values.
- Direct SQL rejects malformed or wrong-root expected and actual JSON and separately rejects wrong-length, uppercase, or non-hex expected and actual SHA-256 values.
- Direct SQL rejects all four one-sided nullable-pair cases: expected JSON without hash, expected hash without JSON, actual JSON without hash, and actual hash without JSON.
- Migration `0011_qrspi_stage_runtime_layout` adds exactly `CHECK ((expected_json IS NULL) = (expected_sha256 IS NULL))` and `CHECK ((actual_json IS NULL) = (actual_sha256 IS NULL))`; either pair may remain wholly absent, neither pair is required, and no trigger, expected-versus-actual comparison, canonical semantic, or cross-row semantic is added.
- Positive direct-SQL controls prove the expected pair may be wholly absent while the actual pair is complete and vice versa, with `PRAGMA foreign_key_check` empty; exact tagged-layout metadata assertions lock both equality checks while preserving the existing columns, strict-table status, composite foreign key, reason literals, JSON/hash checks, and index inventory.
- Every invalid statement uses a fresh complete graph and proves rejection, exact before/after graph equality, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.
- Coverage is ticket acceptance criteria 3 and 4 in full, the diagnostic portions of criteria 5 and 6, criterion 7 parent-release non-completion, and final named coverage reconciliation for the parent ticket; it makes no typed-diagnostic or quarantine claim.
- Passing this child alone does not complete or release the parent migration gate.

## Scenarios

### Scenario: Reject a diagnostic shape contradiction

**Given** a fresh complete tagged runtime graph with a valid revision diagnostic
**When** direct SQL supplies one wrong parent, unsupported literal, invalid bound, malformed JSON, or malformed local hash
**Then** SQLite rejects the statement, the graph is unchanged, foreign keys remain enabled, and `PRAGMA foreign_key_check` is empty

### Scenario: Correct and prove nullable-pair completeness

**Given** the current diagnostic table permits a one-sided expected or actual JSON and SHA-256 pair
**When** the two local equality checks and all four one-sided rejection cases are applied atomically
**Then** every one-sided pair is rejected while either pair may remain wholly absent and exact metadata evidence locks both checks

### Scenario: Preserve semantic, recursive, and release boundaries

**Given** the named diagnostic coverage reconciliation passes
**When** delivery and parent release are considered
**Then** no trigger, canonical semantic, typed-diagnostic, quarantine, or parent-release claim is made, this task requires its own Structure scope review before Plan, and the parent gate remains incomplete

## Notes

Recursive scope outcome T3. Dependency: completed fixture (`workflowd-vs3.4.3.1.2.2.1`); no dependency on sibling outcomes. Primary files: `src/store/migrations.ts`; `test/store/migrations.test.ts`. Provisional changed lines: low 186, likely 275, high 376. Exact acceptance/control/risk coverage: ticket AC3 and AC4 in full; diagnostic portions of AC5 and AC6; AC7 non-release; final named ticket reconciliation; wrong revision identity; reason literals; message and observed-kind/state bounds; expected/actual object JSON and local SHA-256 shape; all four one-sided pairs; either pair wholly absent; exact tagged-layout metadata. Risks retained: unsupported diagnostic literals or bounds, malformed JSON or hashes, one-sided pairs, metadata drift, graph mutation after rejection, non-atomic production/test evidence, and overclaiming triggers, required pairs, expected-versus-actual comparison, canonical semantics, typed diagnostics, quarantine behavior, or parent release. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan. The parent retains cross-child integration accounting and the atomic completion condition.

## Dependencies

- `workflowd-vs3.4.3.1.2.2.1`: Complete tagged graph and reject payload contradictions (blocks)
- `workflowd-vs3.4.3.1.2.2.2`: Reject immutable-reference and diagnostic contradictions (parent-child)


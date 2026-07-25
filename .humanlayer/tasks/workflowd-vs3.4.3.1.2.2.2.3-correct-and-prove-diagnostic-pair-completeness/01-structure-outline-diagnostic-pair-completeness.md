---
task: workflowd-vs3.4.3.1.2.2.2.3-correct-and-prove-diagnostic-pair-completeness
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 2ef27d2d8d11a585e7118776c2b93a679d0bdc9b
---

# Correct and Prove Diagnostic Pair Completeness

Close the SQL-local nullable-pair gap in `qrspi_stage_revision_diagnostics` and prove the complete allocated diagnostic constraint matrix against the inherited tagged runtime graph. The production checks, negative cases, positive absence controls, exact metadata assertions, and named coverage reconciliation remain one atomic vertical slice. Sibling reference evidence and parent release authority remain outside this Bead.

**Bead:** `workflowd-vs3.4.3.1.2.2.2.3`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified)

## Desired End State

- Migration `0011_qrspi_stage_runtime_layout` contains exactly the two additional local checks `CHECK ((expected_json IS NULL) = (expected_sha256 IS NULL))` and `CHECK ((actual_json IS NULL) = (actual_sha256 IS NULL))`.
- Direct SQL rejects diagnostics whose coordinates do not identify an existing common StageRevision, whose reason or bounded text is invalid, whose expected or actual JSON/hash shape is invalid, or whose expected or actual pair is one-sided.
- Every invalid statement runs in a fresh database after `seedValidRuntimeIdentitySpine` and passes through `expectIdentitySpineRejection`, proving rejection, exact equality across the complete eighteen-table graph, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.
- Positive controls prove either diagnostic pair may be wholly absent while the other remains complete; neither pair becomes required and complete pairs remain valid.
- Exact tagged-layout evidence retains the diagnostic columns, strict-table status, composite StageRevision foreign key, reason literals, JSON/hash checks, and sole primary-key index while adding both equality checks.
- Named executable reconciliation covers immediate parent Bead `workflowd-vs3.4.3.1.2.2.2` acceptance criteria 3 and 4 and the diagnostic portions of criteria 5 and 6 without claiming sibling reference coverage; criterion 7 remains an explicit non-release boundary rather than executable SQL evidence.
- No trigger, expected-versus-actual comparison, canonical JSON/hash semantic, typed diagnostic, quarantine behavior, cross-row rule, fixture extension, or parent migration-gate release is added or claimed.
- An independent post-Structure scope review must accept this child before any Plan or Implementation stage begins.

## Implementation Overview

- [ ] Phase 1: Correct and Prove Diagnostic Pair Completeness

---

## Phase 1: Correct and Prove Diagnostic Pair Completeness

Land the complete diagnostic outcome as one independently verifiable slice. Add the two demonstrated DDL checks, exercise every allocated existing and new diagnostic constraint through the inherited fresh-graph rejection contract, prove both allowed asymmetric absence shapes, and lock the resulting table metadata and bounded acceptance allocation together.

### File Changes

- **`src/store/migrations.ts`**: In `qrspiStageRuntimeLayout`, add only `CHECK ((expected_json IS NULL) = (expected_sha256 IS NULL))` and `CHECK ((actual_json IS NULL) = (actual_sha256 IS NULL))` to `qrspi_stage_revision_diagnostics`, adjacent to its existing optional object-JSON and lowercase SHA-256 checks. Keep both pairs nullable and leave the table's columns, primary key, composite StageRevision foreign key, strictness, reason vocabulary, and index behavior unchanged.
- **`test/store/migrations.test.ts`**: Add four named parent-identity descriptors for locally valid but absent workflow, Generation, stage, and revision coordinates. Keep all diagnostic values valid so each case isolates the existing composite foreign key rather than a local check or primary-key collision.
- **`test/store/migrations.test.ts`**: Add seven named literal and bound descriptors: unsupported reason; empty and 2,001-character message; empty and 65-character observed kind; and empty and 65-character observed state. Retain nullable observed values as valid fixture-supported shapes.
- **`test/store/migrations.test.ts`**: Add four named JSON descriptors for malformed and array-root expected JSON and malformed and array-root actual JSON. Add six separate hash descriptors for wrong-length, uppercase, and non-hex expected SHA-256 and the same three actual SHA-256 failures, keeping the paired JSON present and valid in hash cases.
- **`test/store/migrations.test.ts`**: Add all four one-sided pair descriptors against the seeded complete diagnostic: expected JSON without hash, expected hash without JSON, actual JSON without hash, and actual hash without JSON. These cases are the direct behavioral proof for the two production checks.
- **`test/store/migrations.test.ts`**: Execute each of the 25 rejection descriptors as its own Bun test with a fresh `runWithDatabase`, `seedValidRuntimeIdentitySpine`, and `expectIdentitySpineRejection`. Reuse the inherited complete graph and helper unchanged; do not duplicate or extend the fixture.
- **`test/store/migrations.test.ts`**: Add two fresh-database positive controls. In one, clear both expected fields while retaining the complete actual pair; in the other, clear both actual fields while retaining the complete expected pair. Read back the exact nullable/complete arrangement and require enabled foreign keys plus an empty `PRAGMA foreign_key_check` after each successful update.
- **`test/store/migrations.test.ts`**: Extend `creates the exact tagged payload, reference, diagnostic, and operation layout` with the two exact equality-check snippets while preserving its column, strict-table, composite-foreign-key, reason-literal, and JSON/hash assertions. Preserve the separate exact runtime-index inventory and no-runtime-trigger assertions unchanged.
- **`test/store/migrations.test.ts`**: Add a named reconciliation assertion covering 4 parent-identity, 7 literal/bound, 4 JSON, 6 hash, and 4 one-sided-pair rejections, for 25 total rejection cases, plus 2 positive absence controls. Map that executable inventory only to parent acceptance criteria 3 and 4 and the diagnostic portions of criteria 5 and 6; keep criterion 7's parent non-release condition as an implementation-boundary statement, not a behavior the SQL test can prove.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Reconcile all 25 rejection names and both positive controls against this Bead's acceptance criteria, confirming each invalid statement changes only its named field or parent coordinate and uses the inherited fresh complete-graph contract.
- [ ] Inspect the final migration and test diff together to confirm the two local equality checks are the only production change and no required pair, trigger, expected-versus-actual comparison, canonical semantic, typed diagnostic, quarantine behavior, fixture ownership, sibling reference case, cross-row rule, or parent-release claim entered the slice.

## Open Questions

- None. The accepted ancestor Design, recursive allocation, completed fixture dependency, current migration DDL, and demonstrated one-sided-pair gap fix the implementation and verification boundary.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; artifact kind `local_content_addressed_graph_export`; authority limit `Local QRISPI compatibility snapshot; not production Provenance publication`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication or authority, authenticated production gate authority, a production graph root, or production Structure authority.

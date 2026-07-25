---
task: workflowd-vs3.4.3.1.2.2.3-reject-contradictory-operation-ownership-and-reconcile-coverage
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 2a5b10ef4c8562c8f7480f95b509b4cb2685b068
---

# Reject Contradictory Operation Ownership and Reconcile Coverage

Use the completed tagged runtime fixture to prove that physical WorkflowOperations, the common operation-owner spine, and both tagged owner variants cannot disagree on kind, role, owner, or exact parent identity. Every allocated contradiction will fail against a fresh otherwise-valid real-SQLite graph, preserve that graph exactly, and retain foreign-key integrity; the final matrix remains only this child's contribution to the parent's atomic migration gate.

**Bead:** `workflowd-vs3.4.3.1.2.2.3`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified)

## Desired End State

- Direct SQL rejects unsupported common operation, owner, and role tags; role/operation-kind inversions; declared kinds that disagree with physical WorkflowOperations; and ownership of missing physical operations.
- Direct SQL rejects wrong fixed tags and exact-parent coordinates in both tagged owner variants, local revision and step-position bounds, and any tagged owner-kind or operation-role tuple that disagrees with the common owner row.
- Document revisions and implementation steps cannot acquire duplicate producer or publication roles, one physical operation cannot be reused within either tagged owner table, and common ownership prevents reuse across document-revision and implementation-step variants.
- Every invalid statement starts from a fresh complete tagged graph and uses `expectIdentitySpineRejection` to prove exact before/after graph equality, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.
- The named executable matrix covers this Bead's operation-ownership and physical-operation-uniqueness allocation while leaving payload, reference, diagnostic, semantic, lifecycle, and neighboring-owner evidence with their assigned owners.
- No result from this child alone completes or releases the parent migration gate; final coordinated child completeness and parent integration reconciliation remain at Bead `workflowd-vs3.4.3.1.2.2`.

## Implementation Overview

- [ ] Phase 1: Reject Common Owner and Physical Operation Disagreement
- [ ] Phase 2: Reject Tagged Owner Identity and Tuple Disagreement
- [ ] Phase 3: Reject Ownership Reuse and Reconcile Coverage

---

## Phase 1: Reject Common Owner and Physical Operation Disagreement

Exercise the first complete ownership slice from a physical `workflow_operations` row through `qrspi_stage_operation_owners`. The cases prove the common row accepts only the two allocated operation kinds, owner variants, and roles, pairs each role with the right kind, and names an existing physical operation of that exact kind.

### File Changes

- **`test/store/migrations.test.ts`**: Add a named common-owner rejection matrix beside the completed `runtimeFixture`, `seedValidRuntimeIdentitySpine`, and `expectIdentitySpineRejection` harness. Cover unsupported `operation_kind`, `owner_kind`, and `operation_role` values; `produce` with `ArtifactPublish`; `publish` with `StageProduce`; and a missing physical operation.
- **`test/store/migrations.test.ts`**: Add an otherwise-valid case in which the common row's declared kind and role agree with each other but the kind disagrees with the named physical WorkflowOperation. Keep this distinct from the two local role/kind inversion cases so the composite foreign key to `(operation_id, kind)` is directly demonstrated.
- **`test/store/migrations.test.ts`**: Run every descriptor in its own `runWithDatabase` invocation, seed the complete tagged graph once, attempt one statement through `expectIdentitySpineRejection`, and preserve the existing deterministic all-table snapshot and foreign-key assertions.
- **`src/store/migrations.ts`**: No planned change. If an allocated common tag, role/kind, physical-kind, or missing-operation case is unexpectedly accepted, correct only the demonstrated local check or composite foreign key in `0011_qrspi_stage_runtime_layout` and lock that correction in the existing exact metadata assertions.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Confirm each common-owner case isolates one constraint boundary: local vocabulary, role/kind pairing, or physical-operation identity and kind. No case claims that SQL coordinates common rows with tagged children.

---

## Phase 2: Reject Tagged Owner Identity and Tuple Disagreement

Extend the proof through both tagged owner tables. Each statement remains locally valid except for one fixed tag, exact document-revision or implementation-step coordinate, local ordinal, or common-owner tuple, demonstrating the full relational path without entering producer or publisher behavior.

### File Changes

- **`test/store/migrations.test.ts`**: Add document-owner cases for the wrong fixed `owner_kind`; wrong workflow, Generation, stage, or revision parent coordinate; revisions `0` and `1_000_001`; and owner-kind or operation-role disagreement with the referenced common owner tuple.
- **`test/store/migrations.test.ts`**: Add implementation-step owner cases for the wrong fixed `owner_kind`; wrong workflow, Generation, stage, revision, or step-position parent coordinate; revision and position values at `0` and `1_000_001`; and owner-kind or operation-role disagreement with the common owner tuple.
- **`test/store/migrations.test.ts`**: Where an isolated tuple case needs an unused operation, insert an otherwise-valid physical WorkflowOperation and common owner before `expectIdentitySpineRejection` takes its before-snapshot. The attempted tagged insert must remain the only rejected statement, and the helper must still prove that all valid setup rows are unchanged.
- **`test/store/migrations.test.ts`**: Parameterize the parent-coordinate and lower/upper-bound dimensions using the existing named-case patterns, while retaining one fresh database and one contradiction per Bun test.
- **`src/store/migrations.ts`**: No planned change. If an allocated fixed-tag, exact-parent, ordinal, or common-tuple case succeeds, make only the smallest demonstrated `0011` check or composite foreign-key correction and extend the existing exact table metadata assertion.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Confirm every wrong-parent row retains valid local tags, roles, and remaining coordinates, and every common-tuple case avoids a primary-key collision that could hide the intended foreign-key rejection.

---

## Phase 3: Reject Ownership Reuse and Reconcile Coverage

Close the ownership proof over role uniqueness and single physical-operation ownership, then reconcile the named cases with this child allocation. Per-case valid setup may add a spare physical operation, common owner, document parent, or implementation step before the rejection snapshot so each failure demonstrates the intended primary key, unique key, or cross-owner common-spine boundary rather than an incidental constraint.

### File Changes

- **`test/store/migrations.test.ts`**: Add isolated cases proving that one document revision cannot acquire a second `produce` or `publish` role and one implementation step cannot acquire a second `produce` or `publish` role. Use distinct otherwise-valid physical operations and common owners where needed so the tagged parent-plus-role primary key is the rejection boundary.
- **`test/store/migrations.test.ts`**: Add same-table reuse cases that attempt to attach an already-owned document operation to another valid document revision and an already-owned implementation operation to another valid implementation step. Seed any additional valid parent before the helper's before-snapshot so `UNIQUE (operation_id)` is exercised without changing the accepted complete fixture globally.
- **`test/store/migrations.test.ts`**: Add both cross-owner directions: attempt to attach a document-owned physical operation to an implementation step and an implementation-step-owned physical operation to a document revision. Keep the role valid and prove the common spine's single owner tuple plus the tagged composite foreign key reject each crossing.
- **`test/store/migrations.test.ts`**: Reconcile the final named matrix against the common vocabulary and role/kind checks, physical-kind foreign key, both exact tagged-parent foreign keys, both tagged common-owner tuple foreign keys, duplicate-role primary keys, same-table operation uniqueness, and cross-owner operation uniqueness. Map those cases only to this Bead's acceptance subset and explicitly retain the parent atomic-gate condition.
- **`src/store/migrations.ts`**: No planned change. If a duplicate-role, same-table reuse, or cross-owner reuse statement succeeds, make only the smallest demonstrated `0011` key, unique constraint, or composite foreign-key correction and rerun the full metadata, index, graph-preservation, and rejection evidence.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Map every Bead acceptance item to a named executable case and confirm each duplicate or reuse case reaches its intended key or foreign-key boundary rather than failing on fixture setup or an unrelated constraint.
- [ ] Confirm the final diff adds no payload, reference, or diagnostic rejection ownership; typed store API; semantic hash guarantee; trigger; producer, publisher, allocation, transition, claim, progression, bootstrap, quarantine, upgrade, or legacy behavior; neighboring lifecycle; or claim that this child releases the parent gate.

## Open Questions

- None. The accepted ancestor Design, completed fixture dependency, parent allocation, current `0011` schema, and existing real-SQLite rejection harness fix this child's SQL-local boundary. Current checks, keys, and composite foreign keys appear to cover every allocated contradiction, so production migration edits remain tests-first contingency only.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; artifact kind `local_content_addressed_graph_export`, authority limit `Local QRISPI compatibility snapshot; not production Provenance publication`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

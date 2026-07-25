---
task: workflowd-vs3.4.3.1.2.2.1-complete-tagged-graph-and-reject-payload-contradictions
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 10c600c0600280c622d826a0b8bbec9bdb53d1ad
---

# Complete the Tagged Graph and Reject Payload Contradictions

Extend the inherited real-SQLite identity-spine fixture into the complete valid tagged runtime graph, then prove the allocated variant, parent-identity, source-set, payload, nullable-pair, implementation-step-triad, and step-bound contradictions fail in isolation. Every invalid statement will use the existing fresh-database rejection contract so the complete graph remains exactly unchanged, foreign keys remain enabled, and `PRAGMA foreign_key_check` stays empty.

**Bead:** `workflowd-vs3.4.3.1.2.2.1`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified)

## Desired End State

- `seedValidRuntimeIdentitySpine` creates a complete valid graph with non-null document and implementation payloads, one complete ordered implementation step, artifact and commit references, an implementation checkpoint, a revision diagnostic, four physical operations, four common operation-owner rows, and both tagged owner variants.
- The positive fixture proof inventories every parent and runtime table and requires enabled foreign keys plus an empty `PRAGMA foreign_key_check` after seeding.
- Direct SQL rejects wrong document and implementation fixed tags, cross-variant payloads and steps, and otherwise-valid tagged rows attached to the wrong workflow, Generation, stage, or revision identity.
- Direct SQL rejects malformed or wrong-root source-set and payload JSON, invalid local SHA-256 shapes, one-sided document and implementation payload pairs, every incomplete or invalid implementation-step JSON/hash/`final` triad, and positions outside the allocated bounds.
- Every invalid statement starts from a fresh complete graph, attempts one contradiction, and proves exact before/after graph equality, enabled foreign keys, and no foreign-key violations through `expectIdentitySpineRejection`.
- The fixture frontier is reusable by the following reference/diagnostic and operation-ownership children, but this Bead does not claim their rejection matrices or release the parent migration gate.
- Evidence remains SQL-local. Typed aggregate decoding, canonical hash recomputation, coordinated child completeness, transition semantics, triggers, runtime behavior, upgrade preservation, legacy conversion, and neighboring lifecycles remain out of scope.

## Implementation Overview

- [ ] Phase 1: Complete the Tagged Graph and Reject Variant Mismatches
- [ ] Phase 2: Reject Wrong-Parent Tagged Identities
- [ ] Phase 3: Reject Payload Shapes, Pairs, Triads, and Bounds

---

## Phase 1: Complete the Tagged Graph and Reject Variant Mismatches

Establish the shared complete-graph frontier and immediately exercise its document-versus-implementation boundary. The positive fixture proves every deeper table can coexist validly, while fresh rejection cases prove fixed tags and tagged parent types cannot be crossed without changing any seeded row.

### File Changes

- **`test/store/migrations.test.ts`**: Extend the existing `runtimeFixture` and `seedValidRuntimeIdentitySpine` in place. Give one document revision a valid non-null prepared-result object/hash pair, give the implementation revision a valid non-null delivery-evidence object/hash pair, and add one implementation step with a complete prepared-result/hash/`final` triad.
- **`test/store/migrations.test.ts`**: Seed one valid artifact reference, implementation commit reference, implementation checkpoint, and revision diagnostic for sibling reuse. Add two physical WorkflowOperations so the fixture has document and implementation-step producer/publication pairs, then seed four common owner rows and the two valid tagged owner variants without testing their invalid cases here.
- **`test/store/migrations.test.ts`**: Update the exact complete-graph inventory from two to four physical operations and from zero to the required step, reference, checkpoint, diagnostic, common-owner, and tagged-owner rows. Extend the positive seed test to assert `PRAGMA foreign_keys = 1` and an empty `PRAGMA foreign_key_check` result.
- **`test/store/migrations.test.ts`**: Add fresh-fixture cases for wrong fixed `kind` values on document and implementation payload rows, a document payload attached to an implementation common revision, an implementation payload attached to a document common revision, and an implementation step attached to a document revision. Route every case through `expectIdentitySpineRejection`.
- **`src/store/migrations.ts`**: No planned change. If one allocated fixed-tag or cross-variant statement is unexpectedly accepted, correct only the demonstrated `0011_qrspi_stage_runtime_layout` check or composite foreign key and retain the inactive SQL boundary.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Reconcile the positive row inventory with all eighteen snapshot tables and confirm the reference, diagnostic, and ownership rows are valid fixture data only; their contradiction cases remain assigned to sibling Beads.

---

## Phase 2: Reject Wrong-Parent Tagged Identities

Use the complete graph to prove each tagged payload or implementation step remains under its exact relational parent. Each case changes one workflow, Generation, stage, revision, or applicable step coordinate while preserving valid tags, JSON, hashes, and all unrelated fields, isolating the composite foreign key that owns the identity boundary.

### File Changes

- **`test/store/migrations.test.ts`**: Add a named relational case matrix for otherwise-valid document payload rows whose workflow, Generation, stage, or revision coordinate does not identify the matching document common revision.
- **`test/store/migrations.test.ts`**: Add corresponding implementation payload cases for wrong workflow, Generation, stage, and revision coordinates, retaining the fixed `implementation` tag and valid delivery-evidence pair.
- **`test/store/migrations.test.ts`**: Add implementation-step cases whose workflow, Generation, stage, or revision coordinate does not identify the valid implementation payload parent. Keep position locally valid in these cases so position bounds remain independently tested in Phase 3.
- **`test/store/migrations.test.ts`**: Create every descriptor as a separate Bun test with a fresh `runWithDatabase` invocation, one call to `seedValidRuntimeIdentitySpine`, and one statement passed to `expectIdentitySpineRejection`.
- **`src/store/migrations.ts`**: No planned change. If an allocated wrong-parent row is accepted, make only the smallest demonstrated `0011` composite foreign-key correction and lock the corrected DDL in the existing migration metadata assertions.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Confirm every wrong-parent statement is otherwise locally valid and isolates one relational coordinate; no reference, diagnostic, operation-owner, semantic identity, or canonical-hash behavior is claimed.

---

## Phase 3: Reject Payload Shapes, Pairs, Triads, and Bounds

Close this child's SQL-local matrix over the common source set, both tagged payload variants, and ordered implementation steps. The complete graph remains the before-state for every malformed shape, and final reconciliation keeps this result a bounded contribution to the parent's atomic migration gate.

### File Changes

- **`test/store/migrations.test.ts`**: Add common StageRevision cases for malformed `source_set_json`, an object root where an array is required, and `source_set_sha256` values with wrong length, uppercase characters, or non-hex characters. Do not assert collection semantics or canonical hash equality.
- **`test/store/migrations.test.ts`**: Add document prepared-result and implementation delivery-evidence cases for malformed JSON, array roots where objects are required, wrong-length/uppercase/non-hex SHA-256 values, and both one-sided JSON/hash pair directions.
- **`test/store/migrations.test.ts`**: Add implementation-step cases for each incomplete triad combination, malformed or wrong-root prepared-result JSON, invalid hash length/case/characters, and `final` values outside `0` and `1`. Retain the valid all-null and complete triads as fixture-supported control shapes rather than rejection cases.
- **`test/store/migrations.test.ts`**: Add separate lower and upper position cases at `0` and `1_000_001`. Keep all remaining step fields valid so each statement exercises only the allocated bound.
- **`test/store/migrations.test.ts`**: Reconcile all named cases with the Bead acceptance criteria and keep every statement on the inherited fresh-fixture, complete-snapshot, enabled-foreign-key, and empty-foreign-key-check path.
- **`src/store/migrations.ts`**: No planned change. If an allocated source-set, payload, nullable-pair, step-triad, hash-shape, or position case succeeds, correct only that demonstrated local `0011` check and extend the existing exact DDL assertion for the corrected constraint.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Map every Bead acceptance item to a named executable case and confirm the final diff contains no immutable-reference or diagnostic rejection case, operation-ownership rejection case, typed store API, semantic or canonical-hash claim, trigger, runtime behavior, upgrade proof, legacy conversion, child coordination, or parent-gate release claim.

## Open Questions

- None. The inherited accepted Design, parent allocation, completed identity-spine harness, and current `0011` constraints fix this Bead's SQL-local boundary. Existing checks and composite foreign keys cover every allocated contradiction, so production migration edits remain contingency-only.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; artifact kind `local_content_addressed_graph_export`, authority limit `Local QRISPI compatibility snapshot; not production Provenance publication`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

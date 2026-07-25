---
task: workflowd-vs3.4.3.1.2.2-prove-tagged-payload-reference-and-operation-ownership-sql-rejec
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 10fe44c2b8843f26b90d426bddc09912b31786fe
---

# Prove Tagged Payload, Reference, and Operation-Ownership SQL Rejection

Extend the completed identity-spine fixture through every tagged runtime child and shared WorkflowOperation ownership seam, then prove each allocated SQL-local contradiction is rejected in fresh real SQLite. Every case will reuse the deterministic complete-graph snapshot contract, preserve the valid graph exactly, and leave `PRAGMA foreign_key_check` empty without claiming typed semantic or lifecycle enforcement.

**Bead:** `workflowd-vs3.4.3.1.2.2`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified)

## Desired End State

- The existing real-SQLite identity-spine fixture contains valid non-null document and implementation payloads, an ordered implementation step, artifact and commit references, an implementation checkpoint, a revision diagnostic, enough physical producer and publication operations, the common operation-owner spine, and both tagged owner variants.
- Direct SQL rejects wrong fixed payload and owner tags, cross-variant children, wrong parent identities, malformed or wrong-root JSON, forbidden empty collections, invalid local hash shapes, one-sided payload and diagnostic pairs, incomplete implementation-step triads, invalid local ordinals, and invalid diagnostic literals.
- Direct SQL rejects operation role/kind disagreement, disagreement with the physical WorkflowOperation kind, wrong tagged owners, duplicate owner roles, and reuse of one physical operation across document-revision and implementation-step owners.
- Every invalid statement starts from a fresh complete graph, fails in isolation, leaves all inventoried parent and runtime rows exactly unchanged, keeps foreign keys enabled, and leaves `PRAGMA foreign_key_check` empty.
- The demonstrated diagnostic nullable-pair gap in `0011_qrspi_stage_runtime_layout` is closed by the smallest local check correction and locked by metadata plus behavioral tests.
- The evidence remains limited to SQL-local shape, key, foreign-key, and uniqueness guarantees. Typed aggregate decoding, canonical hash recomputation, coordinated child completeness, transition semantics, triggers, runtime behavior, and neighboring lifecycles remain outside this Bead.
- Passing this suite does not complete or release the parent migration gate until its independent file-backed upgrade child also passes.

## Implementation Overview

- [ ] Phase 1: Complete the Tagged Graph and Reject Payload Contradictions
- [ ] Phase 2: Reject Immutable-Reference and Diagnostic Contradictions
- [ ] Phase 3: Reject Contradictory Operation Ownership and Reconcile Coverage

---

## Phase 1: Complete the Tagged Graph and Reject Payload Contradictions

Turn the identity-spine fixture into the complete valid tagged runtime graph and immediately use that graph to prove the document, implementation, and implementation-step payload boundaries. This establishes valid rows in every deeper family needed by later phases while preserving the existing one-statement rejection contract.

### File Changes

- **`test/store/migrations.test.ts`**: Extend `runtimeFixture` and `seedValidRuntimeIdentitySpine` rather than replacing the helper owned by Bead `workflowd-vs3.4.3.1.2.1`. Give the selected document revision a valid prepared-result object/hash, give the implementation revision valid delivery evidence/hash, and insert a valid ordered implementation step with the complete prepared-result/hash/`final` triad.
- **`test/store/migrations.test.ts`**: In the same fixture, insert a valid artifact reference, implementation commit reference, implementation checkpoint, revision diagnostic, additional physical `StageProduce` and `ArtifactPublish` rows, common operation-owner rows, and valid document-revision and implementation-step owner rows. Update the complete-graph count assertion and require an empty `PRAGMA foreign_key_check` after seeding.
- **`test/store/migrations.test.ts`**: Add fresh-fixture direct-SQL cases for wrong document and implementation fixed tags; document payloads attached to implementation common revisions; implementation payloads and steps attached to document revisions; and otherwise-valid tagged children attached to the wrong workflow, Generation, stage, revision, or step identity.
- **`test/store/migrations.test.ts`**: Add payload-shape cases for malformed JSON, array roots where objects are required, wrong hash length, uppercase and non-hex hashes, one-sided document and implementation JSON/hash pairs, and every incomplete or invalid implementation-step JSON/hash/`final` triad. Cover lower and upper implementation-step positions and the allocated common source-set JSON root and SHA-256 shape without asserting canonical semantic equality.
- **`test/store/migrations.test.ts`**: Route every case through the existing `expectIdentitySpineRejection` helper so the complete before/after graph, enabled foreign keys, and foreign-key integrity are acceptance-bearing for each statement.
- **`src/store/migrations.ts`**: No planned Phase 1 change. If a payload, variant, source-set, pair, triad, hash-shape, or step-bound case is unexpectedly accepted, correct only that demonstrated `0011_qrspi_stage_runtime_layout` local constraint and retain the inactive schema boundary.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Reconcile the seeded row inventory with every tagged payload, step, reference, diagnostic, physical-operation, common-owner, and tagged-owner table; confirm each Phase 1 test attempts exactly one contradiction against an otherwise valid complete graph.

---

## Phase 2: Reject Immutable-Reference and Diagnostic Contradictions

Use the populated graph to prove the local authority shapes of artifact, implementation-commit, checkpoint, and diagnostic rows. Start with behavioral cases for diagnostic pair completeness, make the smallest demonstrated `0011` correction, and keep all claims below the semantic identity and canonical-hash boundary.

### File Changes

- **`test/store/migrations.test.ts`**: Add artifact-reference cases for document-versus-implementation parent identity, wrong workflow/Generation/stage/revision identity, empty or malformed repository fields, malformed repository full names, empty paths and media types, and invalid commit, blob, and content hash lengths or characters.
- **`test/store/migrations.test.ts`**: Add implementation commit-reference and checkpoint cases for wrong implementation revision or step parents; lower and upper positions; empty checkpoint identity; malformed repository fields; malformed Git hashes; malformed, wrong-root, or empty required collection JSON; and invalid collection, changed-path, and prepared-evidence SHA-256 shapes.
- **`test/store/migrations.test.ts`**: Add diagnostic cases for wrong revision identity, unsupported reason, empty or over-bound message, invalid observed-kind/state lengths, malformed or wrong-root expected/actual JSON, invalid expected/actual hashes, and each one-sided expected JSON/hash and actual JSON/hash pair. Every case must preserve the complete graph and foreign-key integrity.
- **`src/store/migrations.ts`**: Add equality checks pairing `expected_json` with `expected_sha256` and `actual_json` with `actual_sha256` in `qrspi_stage_revision_diagnostics`. This is the smallest correction demonstrated by the one-sided-pair cases; do not require either pair to be present and do not add a trigger or cross-row semantic rule.
- **`test/store/migrations.test.ts`**: Extend the existing exact tagged-layout DDL assertions to lock both new diagnostic pair checks while preserving all current column, strictness, foreign-key, reason-literal, and index assertions.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Confirm the matrix covers local reference, checkpoint, and diagnostic shapes only: JSON/hash pairing is enforced, but canonical hash recomputation, collection contents, reference semantics, and coordinated child completeness remain assigned to typed writes and strict reads.

---

## Phase 3: Reject Contradictory Operation Ownership and Reconcile Coverage

Finish the complete graph at its shared-operation authority seam. Prove the common owner row and both tagged owner tables agree on physical kind, owner variant, role, exact parent, and single ownership, then reconcile the executable matrix with this Bead's complete SQL-local allocation.

### File Changes

- **`test/store/migrations.test.ts`**: Add common-owner cases for unsupported operation, owner, and role tags; `produce` paired with `ArtifactPublish`; `publish` paired with `StageProduce`; declared operation kind disagreeing with the physical WorkflowOperation; and otherwise-valid ownership rows naming missing physical operations.
- **`test/store/migrations.test.ts`**: Add tagged owner cases for wrong fixed owner tags, wrong document revision or implementation-step parent identities, lower and upper revision or step ordinals, and disagreement with the common owner's owner-kind or operation-role tuple.
- **`test/store/migrations.test.ts`**: Add isolated cases proving one document revision cannot acquire duplicate producer or publication roles, one implementation step cannot acquire duplicate roles, one physical operation cannot be reused by another owner in the same tagged table, and one physical operation cannot cross from a document owner to an implementation-step owner through the common owner spine.
- **`test/store/migrations.test.ts`**: Keep every operation case on the shared `expectIdentitySpineRejection` path and reconcile the final named matrix against all tagged tables, reference families, diagnostic fields, local ordinal and hash guards, common ownership checks, tagged uniqueness constraints, and both Bead scenarios.
- **`src/store/migrations.ts`**: No planned Phase 3 change beyond the Phase 2 diagnostic correction. If an allocated owner-role, physical-kind, tagged-parent, duplicate-role, or physical-operation uniqueness case succeeds, make only the smallest demonstrated `0011` key, check, foreign-key, or unique-constraint correction and rerun all migration metadata and rejection evidence.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Map every acceptance criterion to named executable cases and confirm the final diff adds no typed store API, semantic hash claim, trigger, allocation, transition, claim, progression, bootstrap, quarantine behavior, upgrade-preservation proof, legacy conversion, or parent-gate release claim.

## Open Questions

- None. The accepted ancestor Design, parent allocation, completed identity-spine harness, and current `0011` schema fix the SQL-local boundary. SQL is not expected to require every common revision or common operation-owner row to have a tagged child; that coordinated completeness remains assigned to later atomic writes and strict reads.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; artifact kind `local_content_addressed_graph_export`, authority limit `Local QRISPI compatibility snapshot; not production Provenance publication`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

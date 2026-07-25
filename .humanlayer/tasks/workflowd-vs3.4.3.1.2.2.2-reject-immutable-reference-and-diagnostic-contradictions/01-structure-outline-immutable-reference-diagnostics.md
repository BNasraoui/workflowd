---
task: workflowd-vs3.4.3.1.2.2.2-reject-immutable-reference-and-diagnostic-contradictions
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 3322ddd7aeed5e60d83b2604b7584fcda8eb7408
---

# Reject Immutable-Reference and Diagnostic Contradictions

Use the completed tagged runtime graph to prove that artifact references, implementation commit references, implementation checkpoints, and revision diagnostics reject every allocated SQL-local contradiction. Every invalid statement will run against a fresh complete graph and preserve it exactly; the demonstrated diagnostic JSON/hash pairing gap will be closed by two local checks and locked with behavioral and metadata evidence.

**Bead:** `workflowd-vs3.4.3.1.2.2.2`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified)

## Desired End State

- Direct SQL rejects artifact references with the wrong document parent identity, wrong workflow/Generation/stage/revision coordinates, invalid repository fields, empty artifact fields, or malformed Git and content hashes.
- Direct SQL rejects implementation commit references and checkpoints with wrong implementation parents, invalid positions or checkpoint identity, invalid repository or Git fields, malformed or empty required collections, or malformed local SHA-256 values.
- Direct SQL rejects diagnostics with the wrong revision identity, unsupported reason, invalid message or observation bounds, malformed expected/actual values, malformed local hashes, or a one-sided expected or actual JSON/hash pair.
- `qrspi_stage_revision_diagnostics` permits either expected or actual pair to be wholly absent but rejects either pair when only one member is present; exact migration metadata assertions lock both checks.
- Every invalid statement uses the inherited `seedValidRuntimeIdentitySpine` and `expectIdentitySpineRejection` path, proving exact before/after equality across the complete graph, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.
- Evidence remains limited to SQL-local shape, bounds, keys, foreign keys, and nullable-pair completeness. Canonical hash recomputation, collection contents, semantic reference identity, typed diagnostics, quarantine, triggers, runtime behavior, upgrade preservation, and neighboring lifecycles remain outside this Bead.
- Passing this child alone does not complete or release the parent migration gate.

## Implementation Overview

- [ ] Phase 1: Reject Artifact-Reference Contradictions
- [ ] Phase 2: Reject Commit-Reference and Checkpoint Contradictions
- [ ] Phase 3: Correct and Prove Diagnostic Pair Completeness

---

## Phase 1: Reject Artifact-Reference Contradictions

Exercise the artifact row already present in the complete tagged fixture and prove its document-revision authority, repository shape, artifact fields, and immutable hash shapes. Each case changes one allocated field or parent coordinate while retaining an otherwise valid artifact reference and complete graph.

### File Changes

- **`test/store/migrations.test.ts`**: Add named artifact-reference descriptors for attachment to an implementation rather than document revision and for wrong workflow, Generation, stage, or revision identity. Keep all non-parent values valid so the composite document-parent foreign key is the isolated authority boundary.
- **`test/store/migrations.test.ts`**: Add repository-field cases for empty and over-bound provider/repository identifiers plus too-short, over-bound, and slashless repository full names; add empty path and media-type cases.
- **`test/store/migrations.test.ts`**: Add separate wrong-length, uppercase, and non-hex cases for commit SHA, blob SHA, and content SHA-256. Do not compare hash content with JSON, repository data, or artifact bytes.
- **`test/store/migrations.test.ts`**: Run every descriptor in its own `runWithDatabase` invocation after `seedValidRuntimeIdentitySpine`, then pass its single statement to `expectIdentitySpineRejection`; do not duplicate or extend the fixture owned by Bead `workflowd-vs3.4.3.1.2.2.1`.
- **`src/store/migrations.ts`**: No planned Phase 1 change. If an allocated otherwise-valid artifact contradiction is accepted, make only the smallest demonstrated local `0011_qrspi_stage_runtime_layout` check or composite foreign-key correction and lock that exact correction in the existing tagged-layout metadata test.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Confirm each case isolates one artifact parent, repository, field-bound, or hash-shape contradiction and claims no canonical hash, repository observation, content, or semantic reference guarantee.

---

## Phase 2: Reject Commit-Reference and Checkpoint Contradictions

Prove the two implementation-reference families against the same complete graph. Commit references remain bound to one exact implementation step, checkpoints remain bound to one exact implementation revision, and both families reject their allocated repository, collection, ordinal, and immutable-hash contradictions without asserting collection semantics.

### File Changes

- **`test/store/migrations.test.ts`**: Add implementation commit-reference descriptors for wrong workflow, Generation, stage, revision, or step position, plus lower and upper invalid positions. Keep repository, collection, and hash values valid in parent and ordinal cases.
- **`test/store/migrations.test.ts`**: Add commit-reference repository cases and separate wrong-length, uppercase, and non-hex cases for commit and expected-parent Git hashes. Add malformed, object-root, and forbidden-empty `changed_paths_json` cases plus the three local shape failures for `changed_paths_sha256`.
- **`test/store/migrations.test.ts`**: Add checkpoint descriptors for attachment to a document rather than implementation revision, wrong workflow/Generation/stage/revision identity, and empty checkpoint identity.
- **`test/store/migrations.test.ts`**: Add checkpoint repository cases; wrong-length, uppercase, and non-hex base/final Git hashes; malformed, object-root, and forbidden-empty commit-reference and changed-path collections; and the three local shape failures for collection, changed-path, and prepared-delivery-evidence SHA-256 fields.
- **`test/store/migrations.test.ts`**: Execute every commit-reference and checkpoint descriptor through the inherited fresh complete-graph rejection contract, retaining the positive fixture rows unchanged.
- **`src/store/migrations.ts`**: No planned Phase 2 change. If an allocated otherwise-valid statement succeeds, correct only the demonstrated local reference/checkpoint check or parent foreign key in `0011` and add its exact DDL assertion without broadening into collection-content or cross-row semantics.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Confirm commit-reference cases isolate step authority and checkpoint cases isolate implementation-revision authority; collection tests prove only valid nonempty array shape and local hash shape, not canonical content or ordering.

---

## Phase 3: Correct and Prove Diagnostic Pair Completeness

Complete the child’s diagnostic slice with direct-SQL parent, literal, bound, JSON, hash, and nullable-pair cases. Add only the two checks demonstrated by the one-sided cases, prove complete absence remains valid, and lock the exact `0011` DDL alongside the existing strictness, column, foreign-key, reason-literal, and index evidence.

### File Changes

- **`test/store/migrations.test.ts`**: Add diagnostic descriptors for wrong workflow, Generation, stage, or revision identity; unsupported reason; empty and over-bound messages; and empty and over-bound observed-kind and observed-state values.
- **`test/store/migrations.test.ts`**: Add malformed and wrong-root cases for both expected and actual JSON, plus separate wrong-length, uppercase, and non-hex cases for both expected and actual SHA-256 values.
- **`test/store/migrations.test.ts`**: Add all four one-sided nullable-pair cases: expected JSON without hash, expected hash without JSON, actual JSON without hash, and actual hash without JSON. Route each through `expectIdentitySpineRejection` so the complete graph and foreign-key evidence remain acceptance-bearing.
- **`src/store/migrations.ts`**: Add `CHECK ((expected_json IS NULL) = (expected_sha256 IS NULL))` and `CHECK ((actual_json IS NULL) = (actual_sha256 IS NULL))` to `qrspi_stage_revision_diagnostics`. Do not require either pair, add a trigger, compare expected with actual, or assert canonical or cross-row semantics.
- **`test/store/migrations.test.ts`**: Add positive direct-SQL controls showing the expected pair may be wholly absent while the actual pair remains complete and vice versa, with the resulting graph still passing `PRAGMA foreign_key_check`.
- **`test/store/migrations.test.ts`**: Extend `creates the exact tagged payload, reference, diagnostic, and operation layout` so the diagnostic DDL inventory contains both equality checks while preserving the existing exact columns, strict-table status, composite foreign key, reason literals, JSON/hash checks, and index inventory.
- **`test/store/migrations.test.ts`**: Reconcile the named artifact, commit-reference, checkpoint, and diagnostic descriptor groups with this Bead’s acceptance criteria. Keep the result explicitly bounded to this child’s SQL-local allocation and leave final parent integration accounting to Bead `workflowd-vs3.4.3.1.2.2`.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Map every Bead acceptance item to a named executable case and confirm the final diff adds no fixture extension, operation-ownership rejection, semantic identity, typed diagnostic, quarantine, trigger, runtime, upgrade, legacy-conversion, neighboring-lifecycle, or parent-release claim.

## Open Questions

- None. The inherited accepted Design, parent allocation, completed tagged fixture, current `0011` DDL, and demonstrated diagnostic pair gap fix this child’s SQL-local boundary.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (artifact kind `local_content_addressed_graph_export`, authority limit `Local QRISPI compatibility snapshot; not production Provenance publication`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

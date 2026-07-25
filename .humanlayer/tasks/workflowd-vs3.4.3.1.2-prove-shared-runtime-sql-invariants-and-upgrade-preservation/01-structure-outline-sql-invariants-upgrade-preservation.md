---
task: workflowd-vs3.4.3.1.2-prove-shared-runtime-sql-invariants-and-upgrade-preservation
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: d5eaa71ecd50ed9d79558fb7608d059f70736cad
---

# Prove Shared Runtime SQL Invariants and Upgrade Preservation

Complete the release-gate evidence for the already-installed inactive `0011_qrspi_stage_runtime_layout`. Real SQLite tests will prove that every allocated SQL-local contradiction is rejected without changing a valid runtime graph and that closing and reopening a populated file database across the `0010` to `0011` boundary preserves every shipped Generation and WorkflowOperation value while creating no runtime facts.

**Bead:** `workflowd-vs3.4.3.1.2`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified byte-for-byte)

## Desired End State

- A reusable real-SQLite fixture creates a complete valid document and implementation runtime graph, including runs, common and tagged revisions, an implementation step, immutable references, diagnostics, physical WorkflowOperations, and both tagged ownership variants.
- Direct SQL rejects invalid format, state, kind, owner, and role tags; duplicate current runs and owner-crossing keys; cross-run pointers; cross-variant children; duplicate owner roles and physical-operation ownership; malformed JSON and hashes; invalid ordinals; and guarded nullable-value contradictions.
- Every rejected statement is isolated and leaves the seeded valid graph unchanged, with foreign-key integrity intact.
- A database file built and populated through `runStoreMigrationsThrough0010` is closed, reopened through a fresh current layer, and retains every Generation and WorkflowOperation identity and column value exactly.
- The file-backed upgrade leaves both Generation runtime cursor columns null and all twelve StageRun, StageRevision, tagged payload, step, reference, diagnostic, and ownership tables empty; it performs no inferred legacy conversion.
- The runtime layout remains inactive. No typed aggregate API, transition, allocation, claim, progression, bootstrap, quarantine, legacy conversion, or neighboring lifecycle is introduced.

## Implementation Overview

- [ ] Phase 1: Prove the Runtime Identity Spine Rejects Contradictions
- [ ] Phase 2: Prove Tagged Payload, Reference, and Operation Ownership Invariants
- [ ] Phase 3: Prove Exact File-Backed Upgrade Preservation

---

## Phase 1: Prove the Runtime Identity Spine Rejects Contradictions

Seed one complete valid parent graph and enough document and implementation run/revision history to exercise the Generation cursor, StageRun currentness, common StageRevision identity, and same-run pointers. Add table-driven direct-SQL cases that each begin from valid state, attempt one contradiction, assert SQLite rejection, and compare the complete graph before and after the attempt.

### File Changes

- **`test/store/migrations.test.ts`**
  - Add bounded fixture constants and helpers that insert the required workflow, ticket revision, workflow definition, stage definitions, Generation, physical WorkflowOperations, two StageRuns, common revisions, and valid tagged children using the current `0011` schema. Keep foreign keys enabled and use only deterministic identities, JSON, hashes, ordinals, and timestamps.
  - Add a graph snapshot helper that reads every seeded runtime table in deterministic key order. Reuse `rejected` so each invalid statement must fail, then assert the graph snapshot and `PRAGMA foreign_key_check` are unchanged.
  - Prove direct SQL rejects unsupported Generation formats; invalid run, revision-kind, and revision-state tags; a half-populated Generation cursor; zero and over-bound run/revision/pointer ordinals; duplicate current runs; duplicate owner-crossing keys; and pending, published, or accepted pointers to a revision from another run.
  - Keep the fixture and assertions at the SQL boundary. Do not add typed aggregate Schemas, store methods, or semantic hash recomputation.
- **`src/store/migrations.ts`**: No planned change. If a failing case demonstrates that one of the allocated identity-spine invariants is not enforced by `0011`, make only the smallest correction required for that invariant and retain the structural metadata assertions from the preceding layout child.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Reconcile the Phase 1 matrix with the accepted same-Generation cursor, one-current-run, globally unique owner-crossing key, and same-run pointer decisions; confirm each case snapshots valid state before attempting exactly one contradiction.

---

## Phase 2: Prove Tagged Payload, Reference, and Operation Ownership Invariants

Extend the same valid graph through every tagged child and shared physical-operation ownership seam. Exercise the checks and composite foreign keys that distinguish document revisions from implementation revisions and steps, constrain local JSON/hash shapes, and prevent one physical WorkflowOperation from acquiring contradictory owners.

### File Changes

- **`test/store/migrations.test.ts`**
  - Extend the valid fixture with document prepared output and artifact reference, implementation prepared evidence, ordered implementation-step output, commit reference, checkpoint, revision diagnostic, producer/publication WorkflowOperations, common operation-owner rows, and both tagged owner rows.
  - Add direct-SQL cases for wrong fixed payload/owner tags; document children attached to implementation revisions; implementation children attached to document revisions; steps, commit references, checkpoints, diagnostics, and tagged owner rows attached to the wrong parent identity; and owner-role/operation-kind disagreement.
  - Prove duplicate producer or publication roles for one owner and reuse of one physical WorkflowOperation across document and step owners are rejected by the common ownership spine and tagged uniqueness constraints.
  - Cover each allocated JSON family with malformed text or the wrong root shape, including empty arrays where the schema requires non-empty collections. Cover nullable JSON/hash pairs and the implementation-step JSON/hash/final triad with one-sided values.
  - Cover every runtime hash shape with invalid length, uppercase, or non-hex values as applicable, including workflow/stage definitions, source sets, prepared values, artifact Git/content identity, implementation commit/checkpoint collections, and diagnostic expected/actual hashes.
  - Cover invalid implementation-step, reference, checkpoint, diagnostic, and ownership ordinals. Every case must assert rejection, unchanged valid graph state, and no foreign-key violations.
- **`src/store/migrations.ts`**: No planned change. Correct `0011` only if one of these allocated SQL-local variant, shape, or ownership contradictions is demonstrably accepted; do not add triggers for cross-row semantic completeness assigned to later typed transactions and strict reads.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Compare the completed rejection matrix with the twelve-table structural inventory and confirm every local tag, parent variant, JSON/hash guard, ordinal, owner role, and physical-operation uniqueness seam has executable evidence without claiming semantic or lifecycle enforcement.

---

## Phase 3: Prove Exact File-Backed Upgrade Preservation

Replace the existing same-layer in-memory preservation smoke case with the accepted process-style boundary: create and populate a real database file through `0010`, close that layer, then open a fresh layer on the same file and apply the current migrations. Compare complete shipped rows rather than selected columns and prove the append-only migration infers no runtime authority.

### File Changes

- **`test/store/migrations.test.ts`**
  - Add temporary-directory lifecycle management and a file-backed fixture using `SqliteClient.layer({ filename })`, following the repository's existing close/reopen migration tests.
  - In the first scoped layer, run `runStoreMigrationsThrough0010` and insert multiple Generations and WorkflowOperations with diverse states, currentness, retry lineage, nullable lease/effect/output fields, terminal metadata, JSON values, hashes, and timestamps. Read complete, deterministically ordered `SELECT *` snapshots for both tables and close the layer.
  - In a fresh scoped layer over the same filename, run `runStoreMigrations`, read the same complete ordered rows, and assert exact equality for every pre-existing column value and identity. Assert the migration ledger advances once to `0011` and `PRAGMA foreign_key_check` returns no violations.
  - Assert every upgraded Generation has null `current_stage_key` and `current_stage_run_ordinal`, retains its original `generation_format`, and receives no inferred StageRun association.
  - Query all twelve runtime tables and assert each remains empty after the populated upgrade. This zero-row inventory covers runs, common and tagged revisions, steps, immutable references, diagnostics, the common ownership spine, and both tagged ownership tables.
  - Ensure temporary files are removed even when setup, migration, or assertions fail.
- **`src/store/migrations.ts`**: No planned change. Any correction discovered by this proof must preserve the append-only `0011` boundary, every through-`0010` value and key/index/foreign-key behavior, and the zero-inference rule.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Inspect the final diff to confirm production changes are absent unless required by a demonstrated invariant failure, and that no runtime API, trigger, executable claim index, conversion path, or behavior outside migration verification was added.

## Open Questions

- None. The accepted ancestor Design and completed layout child fix the SQL-local invariant allocation and the `0010` upgrade boundary. SQL cannot require a common revision or common operation-owner row to have its tagged child without a trigger; coordinated completeness remains assigned to later atomic writes and strict reads and is not claimed by this outline.

## Local Authority Limitation

This outline inherits the accepted ancestor Design authority through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; promotion result status `confirmed`, authoritative observation mode `local_content_addressed_compatibility`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

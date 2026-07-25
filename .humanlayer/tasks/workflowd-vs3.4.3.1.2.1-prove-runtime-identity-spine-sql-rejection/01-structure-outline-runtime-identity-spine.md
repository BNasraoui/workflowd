---
task: workflowd-vs3.4.3.1.2.1-prove-runtime-identity-spine-sql-rejection
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 875fb2355d54974ada4149df48cad6f5e4b8a019
---

# Prove Runtime Identity-Spine SQL Rejection

Build the reusable real-SQLite runtime fixture and deterministic unchanged-graph assertion owned by this Bead, then use them to prove every allocated Generation cursor, StageRun currentness, common StageRevision identity, tag, pointer, and ordinal contradiction is rejected. The work remains at the inactive SQL boundary: the tagged payload child extends this harness, the upgrade child owns file-backed `0010` preservation, and no typed runtime or lifecycle behavior is introduced.

**Bead:** `workflowd-vs3.4.3.1.2.1`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified)

## Desired End State

- A reusable fixture creates a valid deterministic identity spine in fresh real SQLite, including the required workflow, ticket revision, workflow and stage definitions, Generations, physical WorkflowOperations, historical and current StageRuns, common document and implementation StageRevisions, valid tagged children, guarded Generation cursor, and same-run revision pointers.
- A shared assertion captures every fixture-owned parent and runtime table in deterministic key order, requires one direct SQL statement to fail, then proves the complete graph is byte-for-byte unchanged and `PRAGMA foreign_key_check` remains empty.
- Rejected statements preserve every seeded historical row unchanged, supplying this child's append-only-history evidence without claiming that SQL generally prohibits valid updates or deletes.
- Direct SQL rejects unsupported Generation formats; invalid StageRun state and currentness values; invalid StageRevision kind and state values; invalid run, revision, cursor, and pointer ordinals; half-populated or cross-Generation cursors; duplicate current runs; duplicate owner-crossing keys; and pending, published, or accepted pointers to another run.
- The harness is ready for the tagged payload, reference, and operation-ownership rejection child to extend without moving ownership of its variant, JSON/hash, nullable-shape, role, or physical-operation cases into this Bead.
- Passing this suite contributes one mandatory result but does not complete or release the parent migration gate until the tagged rejection and file-backed upgrade children also pass.
- No typed aggregate Schema, store method, semantic hash check, monotonic lifecycle rule, trigger, claim path, upgrade proof, inferred runtime fact, or neighboring lifecycle is added.

## Implementation Overview

- [ ] Phase 1: Establish the Reusable Rejection Harness and Local Guards
- [ ] Phase 2: Prove Cursor, Currentness, and Same-Run Identity Guards

---

## Phase 1: Establish the Reusable Rejection Harness and Local Guards

Create the fresh-database fixture and unchanged-state contract first, and prove it end to end with the identity spine's local literal and ordinal checks. Each table-driven case starts from a newly seeded valid graph, attempts exactly one invalid statement, and verifies rejection, complete snapshot equality, and foreign-key integrity before the harness is reused by later cases and the following child.

### File Changes

- **`test/store/migrations.test.ts`**: Add bounded deterministic constants and a fixture helper under the migration-11 suite. Insert parents in foreign-key order; use nullable cursor and pointer fields to break insertion cycles; create historical and current runs plus revisions across run, stage, and Generation boundaries; insert valid document and implementation tagged children; then install valid same-run pointers and the current Generation cursor. Keep `PRAGMA foreign_keys = ON` throughout.
- **`test/store/migrations.test.ts`**: Add a graph snapshot helper that reads every seeded workflow, ticket, definition, Generation, WorkflowOperation, and runtime table with explicit stable ordering. Add one shared rejection assertion that captures the before snapshot, requires the supplied statement to fail, captures the after snapshot, and asserts exact equality plus an empty `PRAGMA foreign_key_check` result.
- **`test/store/migrations.test.ts`**: Add fresh-fixture table-driven cases for an unsupported `generation_format`; invalid StageRun `state` and `is_current`; invalid StageRevision `kind` and `state`; and lower and upper bound violations for StageRun `run_ordinal`, StageRevision `run_ordinal` and `stage_revision`, Generation cursor ordinal, and each revision pointer ordinal. Keep valid tagged children in the fixture but do not claim tagged-child rejection coverage.
- **`src/store/migrations.ts`**: No planned change. Only if one allocated local format, tag, currentness-value, or ordinal case is demonstrably accepted, make the smallest correction to `0011_qrspi_stage_runtime_layout`, retain all existing structural assertions, and add no trigger or semantic lifecycle rule.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Reconcile the fixture and snapshot inventory with the parent Structure allocation: this Bead owns the shared identity-spine harness, while tagged payload/reference/ownership invalid cases and file-backed upgrade behavior remain absent.

---

## Phase 2: Prove Cursor, Currentness, and Same-Run Identity Guards

Apply the Phase 1 fresh-fixture contract to relational contradictions that depend on multiple otherwise valid rows. The executable matrix proves that composite foreign keys and unique indexes preserve same-Generation cursor identity, one current run per stage, globally unique owner-crossing identity, and same-run pending, published, and accepted pointers without claiming cross-row lifecycle semantics reserved for later typed transactions.

### File Changes

- **`test/store/migrations.test.ts`**: Add isolated cases for each half-populated Generation cursor shape and for a cursor whose apparent stage/run identity exists only in another Generation. Assert the complete valid graph and foreign-key state remain unchanged after rejection.
- **`test/store/migrations.test.ts`**: Add cases that attempt a second current StageRun for the same `(workflow_id, generation, stage_key)` and reuse an existing `owner_crossing_key` on another otherwise valid common revision. Exercise the partial current-run index and global owner-crossing uniqueness independently.
- **`test/store/migrations.test.ts`**: Add separate pending, published, and accepted pointer cases that target a valid common revision belonging to another run. Use the existing valid same-run pointers as the before-state so every failed update proves the five-column pointer foreign key protects the owning run identity.
- **`test/store/migrations.test.ts`**: Keep the final matrix explicit about the SQL boundary: do not add cases asserting contiguous or monotonic revision allocation, pointer-to-lifecycle-state agreement, cursor-to-`is_current` agreement, or general update/delete prohibition because the accepted Design assigns those coordinated semantics to later guarded store transactions rather than SQL triggers.
- **`src/store/migrations.ts`**: No planned change. If an allocated cursor, current-run, owner-crossing, or same-run pointer contradiction succeeds, correct only that demonstrated `0011` constraint or index, preserve the inactive append-only migration boundary, and rerun the complete migration-11 metadata and rejection suites.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Map every completed case to the accepted same-Generation cursor, one-current-run, global owner-crossing key, same-run pointer, append-only-history preservation, format/cursor guard, unchanged-graph, and foreign-key controls; confirm the parent gate remains unreleased and no tagged-child, upgrade, typed-store, semantic-hash, progression, bootstrap, quarantine, or legacy-conversion behavior is claimed.

## Open Questions

- None. The accepted ancestor Design, completed `0011` layout, and parent Structure fix the SQL-local allocation. Current repository evidence shows an existing check, partial unique index, global unique key, or composite foreign key for every allocated contradiction, so production changes remain contingency-only.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; promotion result status `confirmed`, authoritative observation mode `local_content_addressed_compatibility`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

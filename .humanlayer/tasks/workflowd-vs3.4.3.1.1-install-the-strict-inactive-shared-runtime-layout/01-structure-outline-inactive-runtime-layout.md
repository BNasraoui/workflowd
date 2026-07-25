---
task: workflowd-vs3.4.3.1.1-install-the-strict-inactive-shared-runtime-layout
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: d56612ebf2a2a4c784aabbc8a7cec91e7df60256
---

# Install the Strict Inactive Shared Runtime Layout

Create one append-only migration after `0010` that installs the complete shared StageRun and tagged StageRevision relational foundation without creating runtime facts or executable behavior. Structural smoke tests will inspect every new table, column, key, foreign key, index, and accepted literal while leaving direct invalid-write cases and exact file-backed upgrade-preservation proof to the next child.

**Bead:** `workflowd-vs3.4.3.1.1`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified byte-for-byte)

## Desired End State

- `runStoreMigrationsThrough0010` remains available beside the existing historical runner, and the current runner appends one migration without changing migrations `0001` through `0010`.
- `qrspi_generations` admits exactly `legacy`, `stage_snapshots_v1`, and `stage_runtime_v1`, with an all-or-none guarded current-stage/current-run cursor that can reference only a positive run ordinal in the same Generation.
- Strict tables represent historical StageRuns, common StageRevisions, separate one-to-one document and implementation payloads, ordered implementation steps, immutable artifact/commit/checkpoint references, bounded revision diagnostics, and exact document/step WorkflowOperation ownership.
- Composite keys, same-run revision pointers, partial currentness, the globally unique owner-crossing identity, publication-operation identity, and unique physical-operation ownership preserve the accepted authority seams.
- Applying the migration creates no StageRun, StageRevision, reference, diagnostic, or ownership facts and adds no trigger, executable claim index, runtime API, transition, bootstrap, or inferred legacy conversion.

## Implementation Overview

- [ ] Phase 1: Establish the Runtime Migration Frontier and Identity Spine
- [ ] Phase 2: Complete the Tagged Runtime Layout and Structural Inventory

---

## Phase 1: Establish the Runtime Migration Frontier and Identity Spine

Append the new migration, preserve the previous-frontier runner, and install the guarded Generation, StageRun, and common StageRevision identities. The focused migration suite will prove the migration order and the complete structural shape of this authority spine against real SQLite before the remaining tagged children are added.

### File Changes

- **`src/store/migrations.ts`**
  - Factor migrations `0009` and `0010` into the retained frontier and export `runStoreMigrationsThrough0010` alongside `runStoreMigrationsThrough0008`; register one new numbered migration only in `runStoreMigrations`.
  - Expand the Generation format boundary to the exact `legacy | stage_snapshots_v1 | stage_runtime_v1` literals and add nullable `current_stage_key` plus `current_stage_run_ordinal` with all-or-none and positive-ordinal checks. If SQLite requires reconstruction, reproduce every existing column, primary key, foreign key, check, and `qrspi_generations_current` partial index without assigning runtime cursor values.
  - Create strict `qrspi_stage_runs` and `qrspi_stage_revisions` tables with bounded identities, positive run/revision ordinals, exact accepted run/kind/revision-state literals, object/array JSON shape and lowercase SHA-256 checks, timestamps, and composite ownership back to the existing Generation and stage-definition records.
  - Put pending, published, and accepted revision pointers on StageRun as nullable same-run composite foreign keys; retain historical runs while enforcing one current run per `(workflow_id, generation, stage_key)` through a partial unique index.
  - Add the non-null, bounded, globally unique `owner_crossing_key` to the common revision row as the stable later-handoff identity seam. Do not add triggers, claim indexes, store methods, or data backfills.
- **`test/store/migrations.test.ts`**
  - Extend the ordered migration and strict-table inventory for the new frontier.
  - Use `pragma_table_info`, `pragma_foreign_key_list`, `pragma_index_list`, `pragma_index_info`, and `sqlite_master` to assert every Generation, StageRun, and common StageRevision column; composite key order; foreign-key target and column order; partial-current index; owner-crossing uniqueness; JSON/hash checks; and exact format, kind, run-state, and revision-state literals.
  - Assert the newly migrated empty database contains no StageRun or StageRevision rows and no runtime trigger or executable claim index.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Compare the Generation, StageRun, and common StageRevision DDL with accepted Design decisions D1-D4 and confirm every pointer remains relationally scoped to its exact run.

---

## Phase 2: Complete the Tagged Runtime Layout and Structural Inventory

Finish the same inert migration with the tagged payloads, implementation-step, immutable-reference, diagnostic, and operation-ownership records required by document persistence and later siblings. Structural tests will enumerate each local authority seam without executing the direct-SQL rejection matrix reserved for the next child.

### File Changes

- **`src/store/migrations.ts`**
  - Add separate strict one-to-one document and implementation revision payload tables whose composite primary/foreign keys bind each payload to one common revision kind rather than creating a nullable union.
  - Add strict ordered implementation-step records with positive position identity and composite ownership by the implementation revision.
  - Add strict immutable artifact, implementation-commit, and implementation-checkpoint reference tables with exact repository, workflow, Generation, run/revision or step, Git SHA, path/content, changed-path/evidence, and checkpoint identities plus their required uniqueness and JSON/hash shape checks.
  - Add the bounded `qrspi_stage_revision_diagnostics` record with one diagnostic identity per readable revision and exact `malformed | missing | duplicate | reordered | hash_mismatch | identity_mismatch` reason literals. This remains storage only; no quarantine behavior is added.
  - Add dedicated document-revision and implementation-step WorkflowOperation ownership tables with exact `produce | publish` role literals, composite owner keys, foreign keys to physical `workflow_operations`, one operation per owner role, and global physical-operation uniqueness. The publication-role ownership row is the accepted publication-operation identity hook.
  - Complete all parent/child and variant foreign keys so document rows, implementation rows, steps, references, diagnostics, and ownership rows cannot cross their accepted relational identity. Add no handoff, reconciliation, delivery, status, readiness, capacity, claim, transition, or bootstrap lifecycle.
- **`test/store/migrations.test.ts`**
  - Extend the strict-table inventory and metadata helpers across every tagged payload, step, reference, diagnostic, and ownership table.
  - Assert every column name and nullability, composite primary-key order, one-to-one and parent/child foreign-key mapping, unique constraint/index, operation-role index, owner-crossing and publication-operation hook, accepted literal set, JSON object/array check, SHA-256/Git SHA shape, and positive ordinal.
  - Assert every new table remains empty after migration and the complete schema still contains no trigger or executable runtime claim index.
  - Keep invalid insert/update cases and the file-backed through-`0010` value-preservation fixture out of this child; those are the next child's explicit verification boundary.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Compare the final table family with the accepted Design's document/implementation tagged model, immutable-reference seams, diagnostic reasons, and both identity hooks; confirm neighboring lifecycles are represented only by inert keys where authorized.
- [ ] Review the final diff to confirm migrations `0001` through `0010` are unchanged and no runtime production file outside `src/store/migrations.ts` was modified.

## Open Questions

- None. The accepted ancestor Design fixes the tagged relational model and authority seams, while this child deliberately stops at migration installation and structural smoke coverage.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; promotion result status `confirmed`, authoritative observation mode `local_content_addressed_compatibility`). In local-QRSPI compatibility mode, that confirmed export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

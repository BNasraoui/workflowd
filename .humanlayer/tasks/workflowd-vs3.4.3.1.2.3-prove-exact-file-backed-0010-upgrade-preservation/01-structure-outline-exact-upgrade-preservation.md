---
task: workflowd-vs3.4.3.1.2.3-prove-exact-file-backed-0010-upgrade-preservation
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T101208Z-abaa7ab0
sha: 4ce205d05205c9a881e642fe3d9bfd81846cceac
---

# Prove Exact File-Backed 0010 Upgrade Preservation

Replace the limited same-connection migration smoke test with a process-style SQLite proof: populate a real database file through `0010`, close it, reopen it through a fresh current layer, and compare every shipped Generation and WorkflowOperation value. The same vertical test proves that `0011` advances the ledger once, preserves the inactive format boundary and relational integrity, creates no runtime authority, and cleans up its temporary file on success or failure.

**Bead:** `workflowd-vs3.4.3.1.2.3`

**Inherited Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`)

## Desired End State

- A real SQLite file populated through `runStoreMigrationsThrough0010` contains multiple valid Generations and WorkflowOperations spanning both shipped Generation formats and diverse operation currentness, retry, lease, external-effect, output, failure, JSON, hash, and timestamp values.
- The historical layer is fully closed before a fresh `SqliteClient.layer({ filename })` applies `runStoreMigrations` to the same file.
- Deterministically ordered complete snapshots prove every pre-existing Generation column and every WorkflowOperation column and identity are exactly unchanged across the upgrade.
- Migration `0011_qrspi_stage_runtime_layout` appears exactly once after the ten-row historical ledger, both new Generation cursor columns are null, and each original `generation_format` remains unchanged.
- All twelve runtime tables remain empty, `PRAGMA foreign_key_check` reports no violations, and the existing Generation and WorkflowOperation index assertions continue to prove the reconstructed schema retains its required keys and currentness indexes.
- Temporary database files are removed after success or failure, and no runtime API, inferred conversion, SQL rejection matrix, or neighboring lifecycle is introduced.

## Implementation Overview

- [ ] Phase 1: Prove the Complete File-Backed Upgrade Boundary

---

## Phase 1: Prove the Complete File-Backed Upgrade Boundary

Build the entire acceptance path in one real-file integration test. The test creates diverse through-`0010` history, captures complete ordered snapshots and the historical ledger, lets that SQLite layer close, opens a separately constructed current layer, and proves exact preservation plus the complete zero-authority postcondition.

### File Changes

- **`test/store/migrations.test.ts`**
  - Replace `preserves through-0010 Generation values without inferring runtime facts` with a file-backed close/reopen test using `mkdtemp`, one database filename, two separate `Effect.runPromise` calls, fresh `SqliteClient.layer({ filename })` values, and `try/finally` cleanup with recursive forced removal.
  - In the historical layer, enable foreign keys, run `runStoreMigrationsThrough0010`, and insert the required workflow, ticket-revision, and workflow-definition parents before inserting multiple Generations. Cover historical and current rows, terminal and nonterminal states, distinct timestamps and repository JSON, both `legacy` and `stage_snapshots_v1`, and all other shipped Generation columns.
  - Insert deterministic WorkflowOperation history that exercises distinct kinds and states, one logical operation with noncurrent retry lineage and a higher current revision, a complete active lease tuple, nullable and populated output/effect/observation fields, retry/currentness fields, terminal failure metadata, JSON values, hashes, and timestamps while satisfying the shipped `0010` constraints.
  - Capture complete `SELECT *` snapshots ordered by `(workflow_id, generation)` and `(logical_operation_id, operation_revision, operation_id)`, plus the complete ordered ten-row `effect_sql_migrations` ledger, before the historical layer closes.
  - In the fresh current layer, enable foreign keys, run `runStoreMigrations`, and read the same complete ordered snapshots. Compare every pre-existing Generation field after separating the two new cursor columns, compare WorkflowOperations directly, and assert each row identity, original value, and original `generation_format` is unchanged.
  - Assert `current_stage_key` and `current_stage_run_ordinal` are null for every upgraded Generation. Assert the ledger retains the exact ten-row prefix and contains exactly one row for migration 11; rerun the current migrator in the same fresh layer and prove no duplicate ledger entry or row mutation occurs.
  - Reuse the canonical `runtimeTables` inventory to query all twelve tables and assert every count is zero. Assert `PRAGMA foreign_key_check` is empty and retain the existing structural assertions for `qrspi_generations_current`, `qrspi_generations_definition`, `workflow_operations_current`, and `workflow_operations_identity_kind` so the real upgrade proof does not weaken key/index fidelity.
  - Keep cleanup local to this test so setup, migration, query, or assertion failure cannot leave the temporary directory behind. Do not share the SQL rejection children’s valid-runtime-graph fixture or add inferred runtime rows merely to inspect the empty schema.
- **`src/store/migrations.ts`**: No planned change. If the file-backed proof demonstrates an actual `0011` preservation defect, make only the smallest correction within the existing append-only `0011_qrspi_stage_runtime_layout`; do not edit migrations `0001` through `0010`, add a later conversion, weaken existing constraints, or infer runtime facts.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts`
- [ ] `bun run check`
- [ ] `git diff --check`

#### Manual Verification

- [ ] Inspect the final diff to confirm the test uses two independently constructed SQLite layer lifetimes over one filename, snapshots every shipped Generation and WorkflowOperation column deterministically, and removes its temporary directory in `finally`.
- [ ] Confirm production code is unchanged unless the test first demonstrates a concrete `0011` defect, and that the result adds no SQL rejection matrix, runtime allocation, transition, claim, bootstrap, quarantine, conversion, trigger, executable claim index, or neighboring lifecycle behavior.

## Open Questions

- None. The accepted ancestor Design, completed layout child, and parent split fix the historical `0010` boundary, append-only `0011`, twelve-table inventory, zero-inference rule, and real-file close/reopen verification pattern.

## Local Authority Limitation

This outline inherits the accepted ancestor Design through the confirmed content-addressed local graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`; promotion result status `confirmed`, observation mode `local_content_addressed_compatibility`). In local-QRSPI compatibility mode, that export is the explicitly authorized snapshot substitute. This outline does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

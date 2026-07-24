# Persist and Reload Document Runtime Aggregates

**Bead:** `workflowd-vs3.4.3.1`

**Parent Design:** `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (accepted revision 3)

**Baseline:** `40e65fa98829efbc50f94679b427fbfb04f1674f`

Establish the inactive document half of the accepted durable stage-runtime model. This child owns the complete append-only shared table layout required by later siblings, but exposes typed create/read behavior only for document aggregates. Nothing in this child initializes, claims, progresses, replaces, bootstraps, or quarantines runtime work.

## Desired End State

- Strict Schemas represent StageRun identity and pointers, common StageRevision identity and lifecycle, the document payload, immutable artifact references, and exact producer/publication WorkflowOperation ownership without a nullable document/implementation union.
- A numbered migration after the current `0010` frontier creates the complete shared runtime table family for both variants, guarded Generation cursor columns, and storage support for the accepted `stage_runtime_v1` literal while preserving all existing row values and creating no inferred runtime rows.
- `QrspiStore` can atomically persist one caller-supplied valid document aggregate and strictly reload it by exact identity.
- Reads reject missing or contradictory payloads, malformed or excess JSON, invalid tags and ordinals, duplicate or reordered records, relational/nested identity disagreement, and canonical hash disagreement as exact typed diagnostics. Reads never mutate or expose rejected rows as trusted state.
- The new state remains inert: WorkflowStart, operation claiming, workers, and runtime composition do not call the new methods.

## Implementation Overview

- [ ] Phase 1: Install the Inactive Shared Runtime Layout
- [ ] Phase 2: Round-Trip One Exact Document Aggregate
- [ ] Phase 3: Reject Contradictory State and Prove Inactivity

## Scope Allocation

| Child obligation | Structure outcome |
| --- | --- |
| Complete append-only shared layout | Phase 1 creates StageRun, common/tagged revisions, implementation-step, immutable-reference, operation-ownership, and diagnostic tables needed by later siblings. |
| Document aggregate round trip | Phase 2 adds only document-facing Schemas and typed store methods. |
| Guarded pointers and ownership | Phase 1 supplies local SQL keys/FKs/current indexes; Phase 2 checks exact run-pointer, revision, artifact, and physical-operation identity. |
| Exact rejection before transition | Phase 3 exercises SQL and strict read diagnostics without adding quarantine or a transition. |
| Legacy preservation and inactivity | Phases 1 and 3 prove existing rows are unchanged and no claim/progression path is introduced. |

The implementation variant tables are schema-only in this child. `workflowd-vs3.4.3.2` owns implementation payload, step, commit, and checkpoint Schemas and store behavior. Later siblings own all mutation protocols, bootstrap, claim, quarantine, restart integration, and policy.

---

## Phase 1: Install the Inactive Shared Runtime Layout

Add the complete relational foundation behind an append-only migration and prove its local invariants against real SQLite. Existing Generations and operations remain historical facts; the migration creates no StageRun, StageRevision, pointer, reference, diagnostic, or ownership row for them.

### File Changes

- **`src/store/migrations.ts`**
  - Retain a `runStoreMigrationsThrough0010` runner for previous-frontier fixtures and append the next numbered migration without editing migrations `0001`-`0010`.
  - Add nullable `current_stage_key` and `current_stage_run_ordinal` Generation cursor columns with an all-or-none shape and positive ordinal checks.
  - Extend the persisted Generation format boundary to admit `stage_runtime_v1` while retaining exact `legacy` and `stage_snapshots_v1` values. If SQLite requires table reconstruction to replace the existing format `CHECK`, copy every existing column value exactly, preserve primary/foreign keys and the partial current index, and prove no runtime fact is inferred.
  - Create strict tables for `qrspi_stage_runs`, `qrspi_stage_revisions`, document and implementation one-to-one payloads, implementation steps, artifact/implementation-commit/checkpoint references, revision diagnostics, and document/step WorkflowOperation ownership.
  - Enforce bounded identities, positive ordinals, exact state/kind/reason literals, object/array JSON shape, lowercase SHA-256 and Git SHA shape, composite parent keys, same-run revision pointers, one current run per Generation/stage, one payload kind per common revision, contiguous-position-compatible keys, immutable-reference uniqueness, and unique physical-operation ownership. Do not add triggers or executable claim indexes.
- **`test/store/migrations.test.ts`**
  - Extend migration-order and strict-table assertions for the new frontier.
  - Inspect Generation columns, accepted format literals, composite keys/FKs, partial current indexes, one-to-one variant ownership, operation-owner uniqueness, and reference/diagnostic checks.
  - Seed the required existing workflow/definition/Generation/operation graph and prove direct SQL rejects invalid tags, cross-variant ownership, duplicate current runs, cross-run pointers, malformed JSON, malformed hashes, invalid ordinals, and duplicate physical-operation ownership.
  - Build a file database through `0010`, snapshot existing Generation/operation values, apply the current migration through a fresh layer, and assert exact value preservation plus zero inferred runtime rows.

### Validation

#### Automated Verification

- `bun test test/store/migrations.test.ts`
- `bun run typecheck`
- `bun run effect:check`

#### Manual Verification

- Compare every table and column with accepted Design decisions D1-D4 and this child's exclusions; confirm implementation and neighboring lifecycles are represented only by inert schema seams.

---

## Phase 2: Round-Trip One Exact Document Aggregate

Expose one small typed store boundary that accepts a complete caller-selected document aggregate, commits its rows atomically, and reloads the same authority in deterministic order. The method is persistence, not a runtime transition: it does not select identities, move an existing pointer, allocate an ordinal, alter Generation format/cursors, or mutate an existing aggregate.

### File Changes

- **`src/qrspi/stage-runtime.ts`**
  - Define bounded `StageRunIdentity`, `StageRevisionIdentity`, StageRun and StageRevision state literals, nullable pending/published/accepted revision pointer values, exact source-set identity, document prepared-result payload, immutable artifact record, operation ownership roles, and the tagged `DocumentStageRevisionAggregate`.
  - Reuse `ExactStageScope`, `ExactStageSources`, `PreparedStageOutput`'s `Document` shape, and `ArtifactReference` from `src/qrspi/contracts/common.ts`; do not create competing source or artifact representations and do not define implementation behavior.
  - Apply semantic filters for one aggregate identity, document tag/payload, same-run pointers, ordered source/artifact ordinals, source-set hash, prepared-result hash, and artifact/reference identity.
- **`src/qrspi/store.ts`**
  - Add row Schemas and extend bounded `QrspiStoreDataError` record/detail vocabulary for stage runs, revisions, document payloads, artifact references, and operation ownership.
  - Add `createDocumentStageRuntimeAggregate` and `readDocumentStageRuntimeAggregate` to `QrspiStorePort`.
  - Decode the complete input strictly before SQL. Insert the caller's StageRun, common revision, document payload, ordered artifact references, and exact producer/publication ownership in one existing `sql.withTransaction` boundary. Rely on caller-supplied exact identities; do not allocate, replace, claim, progress, bootstrap, or quarantine.
  - Reload by the complete run/revision identity with explicit ordering, strict row and JSON Schema decoding, relational/nested identity comparison, tag and role checks, duplicate/reorder detection, and canonical hash recomputation before returning the aggregate.
- **`test/qrspi/store.test.ts`**
  - Add a real SQLite harness and deterministic fixture builders for an existing workflow, definition/snapshot, Generation, producer and publication WorkflowOperations, and one document aggregate.
  - First add a failing test for the desired typed API, then prove atomic create/read equality for run identity, common revision, all three pointer values, exact ordered source/artifact references, prepared document result, and producer/publication operation ownership.
  - Inject an insertion failure after parent rows and assert the transaction leaves no partial runtime rows.

### Validation

#### Automated Verification

- `bun test test/qrspi/store.test.ts`
- `bun test test/store/migrations.test.ts test/qrspi/contracts.test.ts`
- `bun run typecheck`
- `bun run effect:check`

#### Manual Verification

- Inspect the public port to confirm it exposes only exact document create/read persistence and no generalized transition, implementation behavior, claim, bootstrap, or quarantine API.

---

## Phase 3: Reject Contradictory State and Prove Inactivity

Complete the trusted read boundary with one-fault-at-a-time corruption evidence and regress the unchanged runtime entry points. Rejected data remains untouched because durable containment belongs to a later sibling.

### File Changes

- **`src/qrspi/store.ts`**
  - Complete deterministic diagnostics for missing payload/reference/owner rows, duplicate or reordered children, wrong revision kind or operation role/kind, malformed/excess JSON, invalid relational/nested identity, and source/prepared/artifact hash mismatch.
  - Return the first exact bounded `QrspiStoreDataError` and never call the existing WorkflowOperation quarantine helper for a document aggregate read.
- **`test/qrspi/store.test.ts`**
  - Starting from a valid aggregate, mutate one semantic dimension at a time with foreign keys disabled only where needed to model corruption.
  - Assert the exact diagnostic record, reason, identity, and expected/actual hash where applicable for missing, malformed, duplicate, reordered, tag/role, identity, and hash cases.
  - Assert failed reads do not mutate any runtime or WorkflowOperation row and do not return partial aggregate state.
- **`test/qrspi/workflow-start.test.ts`**
  - Add only a regression assertion, if not already covered by existing tests, that ordinary WorkflowStart still produces `stage_snapshots_v1` snapshots/placeholders and creates no StageRun or StageRevision rows.

### Validation

#### Automated Verification

- `bun test test/qrspi/store.test.ts test/store/migrations.test.ts test/qrspi/workflow-start.test.ts`
- `bun run check`

#### Manual Verification

- Review the final diff against the child exclusions: no implementation payload API, transition/replacement, claim/progression, bootstrap, quarantine, external owner lifecycle, status/readiness, capacity control, or legacy conversion behavior.

## Open Questions

- None. The accepted parent Design fixes record ownership and this child deliberately stops at inactive document persistence. The SQLite format-check migration must preserve every existing row value and is accepted only with the file-backed previous-frontier proof in Phase 1.

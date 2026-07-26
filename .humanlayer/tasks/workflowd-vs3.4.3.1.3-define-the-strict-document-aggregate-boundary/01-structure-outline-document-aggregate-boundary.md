---
task: workflowd-vs3.4.3.1.3-define-the-strict-document-aggregate-boundary
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T155332Z-e962fa8e
sha: c294728fd04a449e9a3a3d5c48b98943b6bb0a98
---

# Strict Document Aggregate Boundary

Define and verify the reusable typed preflight boundary for one exact document StageRun aggregate without persisting or reloading it. This Structure inherits accepted Design revision 3 from `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md` (SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`) and relies on the completed T1 migration gate for unchanged SQL shape, preservation, and inactivity evidence.

## Desired End State

- Strict Schemas expose the exact document aggregate's bounded run and revision identities, lifecycle literals, non-null bounded owner-crossing key, three guarded same-run revision pointers, exact source-set identity, optional prepared Document result, optional final artifact, and named producer/publication operation identities.
- `ExactStageSources` is the aggregate's canonical exact identity. `ExactStageScope` and the ticket-required named run/revision identity Schemas are narrow projections of that authority, not parallel row-shaped representations. Guarded pointers carry only the exact revision identity required to reject cross-run input.
- The aggregate directly reuses `ExactStageSources`, `ExactStageScope`, the Document member of `PreparedStageOutput`, and `ArtifactReference`; it introduces no competing source, prepared-output, artifact, operation-role, or persistence-row shape.
- The final artifact is absent or one `ArtifactReference`. It has no aggregate ordinal or reference-hash field because installed `qrspi_artifact_references` is singular per document revision and stores neither field. Ordered technical source identity remains exclusively owned and hash-checked by `ExactStageSources`.
- Producer and publication ownership are structurally distinct named operation-ID fields. There is no role array and therefore no duplicate-role cardinality rule.
- One pure strict preflight accepts an internally consistent aggregate or returns the minimum bounded malformed, identity, or hash diagnostic needed by the next atomic-persistence child before SQL.
- `QrspiStore` exposes only that preflight and its type/error seam. It adds no row Schema, SQL, referenced-operation lookup, persistence, reload, allocation, transition, claim, progression, bootstrap, quarantine, or other runtime mutation behavior.

## Implementation Overview

- [ ] Phase 1: Define and Verify the Exact Document Aggregate Preflight

## Proportionate Delta and Evidence Reuse

- The implementation delta must remain proportionate to this narrow preflight child: one aggregate Schema module, one small pure store method/error seam, and focused tests in the ticket-owned store test surface.
- `src/store/migrations.ts` and `test/store/migrations.test.ts` do not change. The completed T1 gate already proves the installed lifecycle/tag literals, same-run pointer keys, singular final-artifact table, producer/publication owner rows, operation-owner uniqueness, append-only `0010` upgrade preservation, zero inferred runtime rows, and runtime inactivity.
- Existing `test/qrspi/contracts.test.ts` evidence remains authoritative for bounded primitives, excess-property behavior, `ExactStageSources` ordering and canonical source-set hash, accepted-pointer identity, source-content hashes, `ArtifactReference`, and the Document prepared-output shape. This child adds only composition and semantic checks unique to the aggregate.
- Tests reuse the existing common contract fixture shapes and vary one distinct aggregate-level mechanism at a time. They do not create a SQL harness or repeat primitive bounds, general excess-field permutations, accepted-pointer/source-content checks, SQL constraints, or one case per identity field.

## What We're Not Doing

- No migration, SQL statement, persistence row Schema, transaction, referenced-WorkflowOperation validation, rollback test, durable reload, corruption quarantine, or no-mutation assertion suite.
- No implementation aggregate, allocation, transition, replacement, claim, progression, bootstrap, external-owner lifecycle, status/readiness, capacity, receipt, delivery, or reconciliation behavior.
- No competing exact-source, prepared-output, artifact, role-array, or row-shaped identity representation.
- No Plan, implementation, child-task creation, size estimate, or tracker mutation belongs to this Structure revision.

---

## Phase 1: Define and Verify the Exact Document Aggregate Preflight

Add one vertical Schema-to-port-to-fixture slice. A caller can submit a complete caller-selected document aggregate, receive the same strictly decoded value when all identities agree, or receive the exact bounded preflight diagnostic without any database access or durable mutation.

### File Changes

- **`src/qrspi/stage-runtime.ts`**
  - Define `StageRunIdentity` as the workflow/Generation/stage/run projection and `StageRevisionIdentity` as the corresponding projection including revision, using the existing bounded fields from `ExactStageScope`. These names satisfy the ticket without mirroring SQL rows or copying unrelated definition/source fields.
  - Define StageRun and StageRevision lifecycle literals exactly as installed by migration `0011`, the bounded non-null owner-crossing key, and nullable pending, published, and accepted guarded pointers. Each non-null pointer carries only `StageRevisionIdentity`, so preflight can reject a target outside the canonical run.
  - Define the tagged `DocumentStageRevisionAggregate` around one canonical `ExactStageSources` value. Derive and decode its `ExactStageScope`, run identity, and revision identity rather than accepting independent copies.
  - Reuse the Document member of `PreparedStageOutput` for an optional prepared-result/hash pair required by the installed document payload and ticket hash criterion. Recompute only that supported canonical hash.
  - Represent the final artifact directly as optional `ArtifactReference`; compare its workflow, Generation, stage, revision, and repository identity with the canonical aggregate authority. Do not add a collection, ordinal, wrapper, content copy, or artifact-reference hash.
  - Represent ownership as bounded `producerOperationId` and `publicationOperationId` fields. Require the two named physical-operation identities to be distinct, but do not model roles, owner rows, operation kinds, or duplicate-role cardinality in this preflight child.
  - Apply only aggregate-level semantic filters: the `document` tag, same-run guarded pointers, final-artifact identity agreement, distinct named operation IDs, and optional prepared-result canonical-hash agreement. Rely on reused Schemas for exact-source order/hash, accepted-pointer/content integrity, primitive bounds, and excess-property rejection.

- **`src/qrspi/store.ts`**
  - Extend `QrspiStoreDataError` only with one document-aggregate record kind and the narrow expected/actual identity detail needed to identify aggregate mismatches. Reuse the existing bounded reason vocabulary; add no row-specific record kinds or persistence diagnostics.
  - Add one small pure `QrspiStorePort` strict-preflight method consumed by the next child. It decodes unknown input with excess-property rejection, maps structural and aggregate-filter failures to the bounded error seam, and returns the exact decoded aggregate.
  - Keep the method independent of `SqlClient`: no query, transaction, insert, lookup, allocation, mutation, or reload branch is part of its implementation or tests.

- **`test/qrspi/store.test.ts`**
  - Add one deterministic exact document aggregate builder based on the existing common `ExactStageSources`, `PreparedStageOutput.Document`, and `ArtifactReference` fixture shapes; no SQLite or persisted-row fixture belongs in this child.
  - Prove one complete aggregate is accepted and returned exactly, including canonical source authority, derived run/revision identity, owner-crossing key, lifecycle values, all three guarded pointers, optional prepared Document result, optional singular final artifact, and named producer/publication operation IDs.
  - Cover only distinct new failure mechanisms: wrong aggregate tag or one top-level excess property for strict structural decoding, one cross-run guarded pointer, one final-artifact identity disagreement, equal producer/publication operation IDs, and one prepared-result hash mismatch.
  - Assert the bounded public diagnostic for each representative. Do not add duplicate-role, source-order, artifact-ordinal, artifact-reference-hash, primitive-bound, per-field identity, accepted-pointer, source-content, SQL, or no-mutation cases.

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/store.test.ts test/qrspi/contracts.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

## Open Questions

- None. The accepted Design remains authoritative. The installed migration resolves the local representation details: ordered source identity is `ExactStageSources`, the document artifact is singular, and producer/publication ownership has two named operation identities. The ticket's ordered-reference and artifact-hash criteria are preserved through the reused exact-source ordering/hash contract and the strict `ArtifactReference` hash fields, without inventing an artifact ordinal or a recomputable reference hash.

## Local Authority Limitation

This Structure inherits the ancestor Design through the confirmed local content-addressed graph export at `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-provenance-promotion-result-r3-graph-export.json` (SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`). It claims no production Provenance publication, authenticated production gate authority, production graph root, or production Structure authority.

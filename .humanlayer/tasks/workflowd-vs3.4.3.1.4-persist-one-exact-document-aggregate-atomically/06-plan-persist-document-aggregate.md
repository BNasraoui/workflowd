---
task: workflowd-vs3.4.3.1.4-persist-one-exact-document-aggregate-atomically
type: plan
revision: 1
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T155332Z-e962fa8e
sha: b0d6081fce78a4a633b1b7fc0a4b6cac5307c215
---

# Persist One Exact Document Aggregate Atomically Implementation Plan

## Overview

Implement the single `FeatureFit` phase accepted by Structure revision 2 and
`05-structure-scope-review-r2.md`: extend the existing strict document aggregate with only
caller-selected StageRun currentness and activation policy, validate both referenced physical
WorkflowOperations completely inside one SQLite transaction, and insert the exact document
runtime aggregate or no rows. The implementation remains within the reviewed **465 / 700 / 980**
changed-line range.

This plan inherits accepted ancestor Design revision 3 at
`.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md`
(SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`). It changes only:

- `src/qrspi/stage-runtime.ts`
- `src/qrspi/store.ts`
- `test/qrspi/store.test.ts`

No migration, contract, domain, JSON, agent-payload, agent-harness, other test, documentation,
lockfile, Beads, allocation, transition, reload, quarantine, or neighboring capability work is
part of implementation.

## Current State and Exact Reused Boundaries

- `DocumentStageRevisionAggregateStructure` currently contains `kind`, `sources`, `runState`,
  `revisionState`, `ownerCrossingKey`, the three nullable guarded revision pointers, optional
  prepared Document, optional singular `ArtifactReference`, and distinct producer/publication
  operation IDs. Its current pointer semantic checks only the four-field run identity.
- `StageActivationPolicy` is the existing domain union:
  `{ mode: "enabled" | "disabled" }` or
  `{ mode: "conditional", policy: { name, version }, decision: "enabled" | "disabled", reason }`.
  The aggregate adds this existing type and a TypeScript boolean `isCurrent`; it adds nothing else.
- `ExactStageScope` has exactly seven authority fields: `workflowId`, `generation`, `stageKey`,
  `runOrdinal`, `stageRevision`, `workflowDefinitionSha256`, and `stageDefinitionSha256`.
- `StageProduceInput` is the complete production producer envelope:
  `contractVersion`, `scope`, `contract`, `request`, and `requestSha256`, with canonical request
  hash, strict `ExactStageSources`, and outer/nested scope agreement already enforced by its
  Schema filters.
- There is no production `ArtifactPublishInput`. Publication authority must therefore use a
  complete JSON object root decoded through `JsonValueSchema`, bounded to
  `MAX_STAGE_REQUEST_BYTES` by `boundedAgentPayload`, canonically hashed in full, and interpreted
  only by strictly decoding its existing `scope` member as `ExactStageScope`.
- The separate persisted `workflow_operations.scope_json` boundary is the exported
  `AgentExecutionScope` union. Creation must strictly decode it, reject excess properties, require
  `_tag: "GenerationScope"`, and compare `workflowId` and `generation`; it must not define another
  operation-scope type.
- `QrspiStorePort` currently exposes aggregate preflight but no create method. The new method is
  `createDocumentStageRuntimeAggregate(input: unknown, now: Date)` and returns the strictly decoded
  `DocumentStageRevisionAggregate` with `SqlError | QrspiStoreDataError` in its error channel.
  `now` is the only separate persistence metadata; all domain identities and states come from the
  decoded aggregate.
- `readStageProduceInput` supplies the Effect 3 pattern for exact operation lookup, strict
  `Schema.parseJson(StageProduceInput)` decoding with `onExcessProperty: "error"`, and canonical
  complete-input hash checking. The create path reuses the mechanism without invoking its
  quarantine behavior.
- Migration `0011` already supplies all target tables, checks, keys, and foreign keys. Existing
  migration tests already prove primitive bounds, strictness, pointer foreign keys, operation
  kind/role ownership, uniqueness, and null-first fixture order; this plan does not repeat them.

## Exact Storage Mapping

The create transaction writes only these current columns:

| Aggregate fact | Existing table and columns |
| --- | --- |
| Run identity and definitions | `qrspi_stage_runs(workflow_id, generation, stage_key, run_ordinal, workflow_definition_sha256, stage_definition_sha256)` |
| Run facts | `state`, boolean `isCurrent` as `is_current` (`0 | 1`), canonical `activationPolicy` as `activation_policy_json`, and initially-null `pending_revision`, `published_revision`, `accepted_revision` |
| Common revision | `qrspi_stage_revisions(workflow_id, generation, stage_key, stage_revision, run_ordinal, kind, state, owner_crossing_key, source_set_json, source_set_sha256, created_at, updated_at)` |
| Ordered source identity | `source_set_json = JSON.stringify(sources.sources.map(({ role, artifact }) => ({ role, artifact })))`; `source_set_sha256 = sources.sourceSetSha256` |
| Document payload | `qrspi_document_stage_revisions(workflow_id, generation, stage_key, stage_revision, kind, prepared_result_json, prepared_result_sha256, created_at, updated_at)`; both prepared columns are null when absent, otherwise the complete prepared Document value and supplied canonical hash |
| Optional final artifact | One row in `qrspi_artifact_references` using `workflow_id`, `generation`, `stage_key`, `stage_revision`, `provider_instance_id`, `repository_id`, `repository_full_name`, `commit_sha`, `path`, `blob_sha`, `content_sha256`, `media_type`, `created_at`, and `updated_at` |
| Common physical ownership | Two rows in `qrspi_stage_operation_owners(operation_id, operation_kind, owner_kind, operation_role, created_at)` with exact pairs `StageProduce/document_revision/produce` and `ArtifactPublish/document_revision/publish` |
| Document ownership | Two rows in `qrspi_document_stage_revision_operations(workflow_id, generation, stage_key, stage_revision, owner_kind, operation_role, operation_id, created_at, updated_at)` with fixed `document_revision` and exact producer/publication IDs |

`activation_policy_json` must be deterministic canonical object text. Serialize decoded enabled or
disabled policy as `{"mode":"..."}`. Serialize conditional policy in canonical key order as
`{"decision":...,"mode":"conditional","policy":{"name":...,"version":...},"reason":...}`.
Do not export a new canonical text encoder or edit `domain.ts`.

## Strict TDD Discipline

Follow every numbered behavior below in order. For each behavior: edit only the focused test first,
run the named `bun test ... -t ...` command, and record the stated feature-missing failure in the
implementation session before touching production. A syntax, fixture, or unrelated SQL failure is
not an acceptable RED; fix the test and rerun until it fails for the stated missing behavior. Then
add only the production code named in that GREEN step and rerun the same command to green before
continuing. Do not batch a role-by-field matrix or write production ahead of its focused failing
test.

---

## Phase 1: Validate Authority and Persist the Exact Aggregate

### 1. Add the exact StageRun metadata boundary

**RED — `test/qrspi/store.test.ts`**

1. Extend `documentAggregate()` with `isCurrent: true` and a real existing
   `StageActivationPolicy`, using the conditional shape so the full policy survives strict decode.
2. Keep each guarded pointer null or equal to the fixture's own complete revision identity.
3. Update the existing acceptance test to assert these two fields round-trip.
4. Run:

   ```bash
   bun test test/qrspi/store.test.ts -t "accepts one exact document aggregate"
   ```

   Record the expected RED: strict aggregate decoding rejects `isCurrent` and `activationPolicy`
   as unexpected fields because the production structure does not yet define them.

**GREEN — `src/qrspi/stage-runtime.ts`**

1. Import and reuse `StageActivationPolicy` from `./domain`.
2. Add only `isCurrent: Schema.Boolean` and `activationPolicy: StageActivationPolicy` to
   `DocumentStageRevisionAggregateStructure`.
3. Add no skip, terminal, cursor, selection, allocation, publication, or progression field.
4. Rerun the focused command and require green.

### 2. Enforce null-or-own-new-revision initial pointers

**RED — `test/qrspi/store.test.ts`**

1. Add one focused test that changes one pointer to the same workflow, Generation, stage, and run
   but `stageRevision + 1`.
2. Assert bounded `QrspiStoreDataError`, record `document_stage_revision_aggregate`, reason
   `identity_mismatch`, and expected/actual identities including the revision coordinate.
3. Retain the existing cross-run test as reused proof; do not create a three-pointer or five-field
   permutation matrix.
4. Run:

   ```bash
   bun test test/qrspi/store.test.ts -t "rejects a guarded pointer to another revision in the same run"
   ```

   Record the expected RED: current four-field `sameRun` semantics accept the different revision.

**GREEN — `src/qrspi/stage-runtime.ts`**

1. Replace the pointer check with equality against one complete `StageRevisionIdentity` projected
   from `sources`, including `stageRevision`.
2. Preserve bounded diagnostics and every existing artifact, operation-ID, and prepared-result
   check.
3. Rerun the focused test and then the complete preflight file:

   ```bash
   bun test test/qrspi/store.test.ts
   ```

### 3. Establish the real-SQLite create fixture and missing-authority boundary

**RED — `test/qrspi/store.test.ts`**

1. Add the existing repository cleanup pattern: `afterEach`, `mkdtemp`/`rm`, `tmpdir`/`join`,
   `SqlClient`, `SqliteClient`, `Layer`, `Schema`, `QrspiStore`, and `QrspiStoreLive`.
2. Build one narrow `storeLayer` and a seed helper with foreign keys enabled. Insert only the exact
   prerequisite rows in foreign-key order:
   - `qrspi_workflows(workflow_id, branch_name, created_at, updated_at)`;
   - `qrspi_ticket_revisions(workflow_id, ticket_revision_sha256, revision_json, checked_at)`;
   - `qrspi_workflow_definitions(definition_sha256, definition_json, created_at)`;
   - the matching `qrspi_stage_definitions` row with all current definition/registration columns;
   - `qrspi_generations` with the current columns, `generation_format = 'stage_runtime_v1'`, and null
     current-stage cursor;
   - optional exact WorkflowOperation rows using all currently required columns from the existing
     replay/migration fixture pattern.
3. Construct producer input with the real full `StageProduceInput` shape and canonical hash.
   Construct publication input as an object containing exact `scope` plus representative
   uninterpreted CAP-D5-owned fields. Store both operation scopes as
   `{ _tag: "GenerationScope", workflowId, generation }`.
4. Add one shared `expectNoDocumentAggregateRows(sql, aggregate)` helper. It must query and require
   zero rows in exactly these six families for the aggregate identity:
   `qrspi_stage_runs`, `qrspi_stage_revisions`, `qrspi_document_stage_revisions`,
   `qrspi_artifact_references`, `qrspi_stage_operation_owners`, and
   `qrspi_document_stage_revision_operations`.
5. Add one mechanism-level missing-row test with a valid producer but absent publication row. Call
   `store.createDocumentStageRuntimeAggregate(aggregate, now)`, assert `QrspiStoreDataError` with
   record `workflow_operation`, the absent publication ID, reason `missing`, then invoke the shared
   zero-row helper.
6. Run:

   ```bash
   bun test test/qrspi/store.test.ts -t "rejects a missing aggregate operation before writing runtime rows"
   ```

   Record the expected RED: `QrspiStorePort` has no create method.

**GREEN — `src/qrspi/store.ts`**

1. Add the exact create signature to `QrspiStorePort`.
2. Implement the method so `preflightDocumentStageRevisionAggregate(input)` completes before
   `sql.withTransaction` begins.
3. Inside the transaction, select the five authority columns for both exact IDs:
   `operation_id`, `kind`, `scope_json`, `input_json`, and `input_sha256`. Decode row shape with a
   local strict Schema and return bounded missing/malformed operation errors.
4. For this increment only, complete both exact row lookups before returning the aggregate; write no
   runtime row yet. Rerun the missing-row test and require green.

### 4. Decode producer, publication, and durable Generation scopes strictly

**RED — `test/qrspi/store.test.ts`**

1. Add one mechanism-grouped malformed-authority `test.each` with only representative cases:
   - a hash-valid producer input with one unexpected top-level field;
   - a malformed publication input root (array or primitive, not object);
   - a valid input paired with malformed or excess `workflow_operations.scope_json`.
2. Each case must assert exact operation ID, record `workflow_operation`, reason `malformed`, and the
   shared zero-row helper. Do not multiply cases by both roles or every scope field.
3. Run:

   ```bash
   bun test test/qrspi/store.test.ts -t "rejects malformed aggregate operation authority"
   ```

   Record the expected RED: row existence alone currently accepts malformed producer/publication
   inputs and malformed durable Generation envelopes.

**GREEN — `src/qrspi/store.ts`**

1. Add a transaction-local authority validator shared by the two aggregate roles.
2. Decode each `scope_json` through `Schema.parseJson(AgentExecutionScope)` with
   `onExcessProperty: "error"`, then require `_tag === "GenerationScope"`.
3. For producer authority, decode the complete `input_json` with the existing
   `Schema.parseJson(StageProduceInput)` and `onExcessProperty: "error"`. Do not project before
   decoding and do not weaken nested request/source filters.
4. For publication authority, define no `ArtifactPublishInput`. Decode the complete `input_json` as
   a `Schema.Record({ key: Schema.String, value: JsonValueSchema })` object root, apply
   `boundedAgentPayload(MAX_STAGE_REQUEST_BYTES, "ArtifactPublish input")`, then require a `scope`
   member and strictly decode only that member as `ExactStageScope` with excess rejection.
5. Map every parse, bound, extraction, and synchronous canonical-hash exception into bounded
   `QrspiStoreDataError` rather than a defect. Do not quarantine either operation in this create
   path.
6. Rerun the grouped test and require green.

### 5. Enforce kind, complete input hash, and all exact authority fields

**RED — `test/qrspi/store.test.ts`**

Add one focused test per failure mechanism, distributed across producer and publication rather than
duplicated by role:

1. **Wrong role/kind:** swap the referenced kinds or place an `ArtifactPublish` row at the producer
   ID. Expect `identity_mismatch`, exact operation ID, and zero rows.
2. **Complete canonical input hash:** mutate an uninterpreted publication-specific extra field while
   retaining its stored `input_sha256`. Expect `hash_mismatch`, exact expected/actual hashes, and
   zero rows. This proves extra publication fields are hash-bound without giving them D3 semantics.
3. **Shared exact authority:** use one hash-valid operation input whose `stageDefinitionSha256`
   differs. Expect `identity_mismatch` with bounded expected/actual details and zero rows. This is the
   sole representative proving comparison extends beyond the five positional fields.
4. **Durable Generation authority:** use a valid strict `GenerationScope` with a different
   `generation`. Expect `identity_mismatch`, exact operation ID, and zero rows. This separately proves
   `workflow_operations.scope_json` is compared rather than merely decoded.
5. Run each new test immediately after adding it, before production edits:

   ```bash
   bun test test/qrspi/store.test.ts -t "rejects the wrong aggregate operation kind"
   bun test test/qrspi/store.test.ts -t "hash-binds the complete publication input"
   bun test test/qrspi/store.test.ts -t "compares complete exact stage authority"
   bun test test/qrspi/store.test.ts -t "compares the durable Generation operation scope"
   ```

   For each command, record the expected RED: the current validator accepts the named disagreement
   because it does not yet enforce that mechanism.

**GREEN — `src/qrspi/store.ts`**

After each RED, add only its check and rerun its command:

1. Require producer kind `StageProduce` and publication kind `ArtifactPublish`; role comes from the
   aggregate field and the fixed ownership role, because `workflow_operations` has no role column.
2. Recompute `canonicalSha256` over each complete decoded input. For publication this includes every
   uninterpreted extra member. Compare with `input_sha256` before extracting semantic authority.
3. Use one shared equality helper for both operations' projected `ExactStageScope`. Compare all
   seven fields individually: `workflowId`, `generation`, `stageKey`, `runOrdinal`,
   `stageRevision`, `workflowDefinitionSha256`, and `stageDefinitionSha256`.
4. Separately compare durable `GenerationScope.workflowId` and `.generation` to aggregate sources.
5. Ensure both operation validations finish before the first insert into any runtime or ownership
   table. Do not read latest rows, mutate operations, or quarantine.

### 6. Prove transaction rollback after parent runtime insertion

**RED — `test/qrspi/store.test.ts`**

1. Add the single rollback test before implementing aggregate writes.
2. Seed fully valid authority, then install one test-only trigger on
   `qrspi_document_stage_revision_operations` that uses
   `SELECT RAISE(ABORT, 'simulated document aggregate crash')` before the first document-owner
   insert. This point is after parent runtime rows and common ownership have begun but before
   ownership completion.
3. Call create, assert the existing SQL failure channel (inspect `Effect.exit`/`Cause.pretty` as in
   WorkflowStart rollback coverage), and invoke the same complete zero-row helper. Drop no trigger
   inside production; fixture disposal isolates it.
4. Run:

   ```bash
   bun test test/qrspi/store.test.ts -t "rolls back the complete document aggregate after a parent write"
   ```

   Record the expected RED: valid authority currently returns without reaching any transaction-
   covered aggregate insert, so the trigger is not exercised and no SQL failure is returned.

**GREEN — `src/qrspi/store.ts`**

Within the existing authority transaction, add only enough ordered writes to reach the trigger:

1. Insert the new `qrspi_stage_runs` row under the full caller identity with exact state,
   `is_current`, both definition hashes, deterministic activation policy JSON, and all three pointer
   columns explicitly `NULL`. Never select or update an existing run.
2. Insert `qrspi_stage_revisions` with exact identity/run, kind `document`, lifecycle state,
   owner-crossing key, ordered `{ role, artifact }` source projection, and supplied source hash.
3. Insert `qrspi_document_stage_revisions`, using a null pair when prepared output is absent or the
   exact prepared Document JSON/hash pair when present.
4. Insert the optional singular `qrspi_artifact_references` row when present.
5. Update only the newly inserted full run primary key and set each pointer to `NULL` or exactly
   `sources.stageRevision` according to the decoded caller pointers. Use `RETURNING` and fail if the
   affected-row count is not one. This is initial pointer installation, not a transition.
6. Insert both common `qrspi_stage_operation_owners` rows in fixed produce/publish form.
7. Attempt the first document owner insert so the test trigger aborts. Keep every step in the same
   `sql.withTransaction` and let the SQL error escape unchanged.
8. Rerun the rollback test and require SQL failure plus zero rows in all six families.

### 7. Commit one complete exact aggregate

**RED — `test/qrspi/store.test.ts`**

1. Add exactly one complete success case using the same real-SQLite fixture. Give its three pointers
   a mixed valid shape (at least one null and at least one own-new-revision pointer), `isCurrent`, a
   conditional activation policy, prepared Document, singular final artifact, exact producer input,
   and publication input with representative uninterpreted extra fields.
2. Assert the returned value equals the strictly decoded caller aggregate.
3. Query and assert every persisted field listed in **Exact Storage Mapping**, including:
   - run state/currentness, canonical activation policy JSON, both definition hashes, and exact
     supplied final pointers;
   - revision state, owner crossing, ordered source projection, and source hash;
   - exact prepared Document JSON/hash and singular artifact columns;
   - both common owner rows and both document owner rows with exact kinds/roles/IDs.
4. Snapshot or query the Generation `generation_format`, cursor fields, and lifecycle/currentness,
   plus both WorkflowOperation lifecycle/currentness columns, before and after; assert they do not
   change.
5. The successful non-null pointer result, against the installed circular foreign keys, is the
   focused evidence that insertion was null-first and the revision preceded pointer installation.
   Do not add a second insertion-order trigger or duplicate migration constraints.
6. Run:

   ```bash
   bun test test/qrspi/store.test.ts -t "persists one exact document aggregate atomically"
   ```

   Record the expected RED: the incremental writer does not yet complete both document ownership
   rows (and therefore cannot satisfy the full exact persisted graph assertion).

**GREEN — `src/qrspi/store.ts`**

1. Complete the second exact `qrspi_document_stage_revision_operations` row and any missing return
   path needed for the success assertion; add no new abstraction or behavior beyond eliminating
   duplication already present in the tested path.
2. Return the preflight-decoded aggregate only after transaction commit.
3. Rerun the focused success command, then the rollback command, and require both green.

### 8. Reconcile the intentional producer/publication distinction without another behavior

Do not add another test or production increment here. Confirm the already-recorded RED/GREEN
evidence forms one focused distinction without a role matrix:

1. Step 4's hash-valid producer excess-field case proves full strict `StageProduceInput` rejection.
2. Step 7's sole complete success case proves a bounded publication-specific extra is accepted and
   interpreted only through its strict shared `scope` projection.
3. Step 5's publication hash-mismatch case proves changing that uninterpreted extra without changing
   `input_sha256` is rejected.

Review those three named tests together. They must assert only D3-owned outcomes and must not name,
define, or semantically validate `publicationKind`, Git candidate/parent/head authority, custody,
workspace, attribution, receipt, delivery, or any other CAP-D5 publication meaning.

## Required Transaction Order

The final implementation must visibly preserve this exact order inside one `sql.withTransaction`:

1. Load producer operation by exact `producerOperationId`.
2. Strictly validate producer row, `GenerationScope`, expected `StageProduce` kind, full strict
   `StageProduceInput`, complete canonical input hash, and all seven exact scope fields.
3. Load publication operation by exact `publicationOperationId`.
4. Strictly validate publication row, `GenerationScope`, expected `ArtifactPublish` kind, bounded
   complete JSON-object input, complete canonical input hash, and strict shared `ExactStageScope`
   projection across all seven fields.
5. Only after both validations finish, insert `qrspi_stage_runs` with three null pointers.
6. Insert `qrspi_stage_revisions`.
7. Insert `qrspi_document_stage_revisions`.
8. Insert the optional singular `qrspi_artifact_references` row.
9. Update only the just-inserted full StageRun primary key to the exact null-or-self pointer values
   and require one returned row.
10. Insert producer and publication rows in `qrspi_stage_operation_owners`.
11. Insert producer and publication rows in `qrspi_document_stage_revision_operations`.
12. Return the decoded aggregate after commit.

No operation or Generation update, latest-row query, upsert, retry, allocation, existing-run lookup,
existing-pointer movement, or inferred value belongs anywhere in this sequence.

## Focused and Final Verification

Run in this order after all TDD increments are green:

```bash
bun test test/qrspi/store.test.ts
bun test test/qrspi/contracts.test.ts test/qrspi/stage-replay.test.ts test/store/migrations.test.ts
bun run typecheck
bun run effect:check
bun run check
```

Then inspect `git diff --stat` and `git diff --check`. Confirm implementation changes are confined to
`src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`, and `test/qrspi/store.test.ts`; the plan artifact
itself is QRSPI process output and contributes zero implementation changed-line risk. Reconcile the
human-authored implementation delta against the accepted one-phase **465 / 700 / 980** estimate.

## Final Manual Review

- [ ] The aggregate's only new facts are boolean `isCurrent` and existing
      `StageActivationPolicy`; all non-null initial pointers equal the complete new revision.
- [ ] Strict aggregate preflight occurs before SQL.
- [ ] Both operations are completely validated before the first runtime or ownership insert.
- [ ] Producer authority is full strict `StageProduceInput`; publication authority is bounded
      complete JSON/object canonical hashing plus strict shared `ExactStageScope` projection only.
- [ ] Both definition hashes, all other five `ExactStageScope` fields, and the separate strict
      `workflow_operations.scope_json` Generation envelope are compared for both operations.
- [ ] The run is inserted with three null pointers, the revision is inserted next, and only that new
      full run identity receives the exact supplied null-or-self pointers.
- [ ] One complete success case proves every mapped field and both ownership layers; one shared
      helper proves zero rows for every authority rejection; one trigger proves full rollback.
- [ ] Tests remain grouped by mechanism and contain no role-by-field matrix or duplicated primitive,
      source, artifact, migration-constraint, or broad rollback matrix.
- [ ] No CAP-D5 publication semantics and no CAP-D7 selection, allocation, transition, claim,
      progression, replacement, bootstrap, cursor, or lifecycle policy was introduced.

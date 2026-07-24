---
task: workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-vs3.4.3
sha: 50be40c936c696c4030bd2a2cbb6c9a0bdc8f375
---

# Durable Tagged Stage Runtime State

Add the durable StageRun and tagged StageRevision aggregate behind `QrspiStore`, preserving the existing WorkflowStart and shared WorkflowOperation foundations. Each phase crosses Schema, strict SQLite, typed store behavior, and real-database verification while retaining the accepted boundaries: CAP-D7 selects and advances work, downstream capabilities execute external lifecycles, and CAP-D11 handles offline legacy recovery.

## Desired End State

- `QrspiStore` persists and strictly decodes historical StageRuns, common StageRevisions, exact document or implementation payloads, ordered implementation steps, immutable references, operation ownership, guarded pointers, and bounded diagnostics.
- Only a complete, exact, idempotent bootstrap may move a current Generation from nonclaimable `stage_snapshots_v1` placeholders to executable `stage_runtime_v1` state.
- Every state change fences all applicable Generation, format, run, revision, pointer, source, operation revision, lease, and observation authority in one transaction; stale or failed writes leave no partial effects.
- Revision replacement preserves monotonic immutable history and remains distinct from WorkflowOperation retry.
- Corrupt mutable runtime state reaches one exact terminal aggregate disposition without guessed repair, successor release, or loss of uncertain-effect evidence.
- Append-only upgrades preserve shipped legacy rows, and file-backed restart restores exact pre-runtime, runtime, and quarantined state.

## Implementation Overview

- [ ] Phase 1: Persist and Reload Tagged Runtime Aggregates
- [ ] Phase 2: Fence Runtime Transitions and Replace Revisions
- [ ] Phase 3: Bootstrap One Fresh Generation into Claimable Runtime
- [ ] Phase 4: Quarantine Corrupt Runtime Aggregates
- [ ] Phase 5: Prove Upgrade and Restart Boundaries

## Decision Work Identities

The local terminal work uses `SRT-D1` through `SRT-D10`, each covering the corresponding accepted Design decision `D1` through `D10`. These names are local to `workflowd-vs3.4.3` and do not collide with the parent feature's existing `CAP-D1` through `CAP-D12` capabilities.

| Local work | Accepted decision | Primary phase |
| --- | --- | --- |
| `SRT-D1` | Persist tagged runtime records | Phase 1 |
| `SRT-D2` | Persist guarded run and revision pointers | Phase 1 |
| `SRT-D3` | Bind shared operations to exact runtime owners | Phase 1 |
| `SRT-D4` | Enforce SQL and semantic runtime invariants | Phase 1 |
| `SRT-D5` | Fence every runtime transition atomically | Phase 2 |
| `SRT-D6` | Replace StageRevisions monotonically | Phase 2 |
| `SRT-D7` | Quarantine corrupt runtime aggregates | Phase 4 |
| `SRT-D8` | Bootstrap exact executable runtime | Phase 3 |
| `SRT-D9` | Recover exact formats and preserve legacy facts | Phase 5 |
| `SRT-D10` | Prove runtime state with real SQLite | Phases 1-5, closed in Phase 5 |

`SRT-D8` depends on the reusable `SRT-D5` fencing boundary established in Phase 2. External `CAP-D7` remains the owner of run selection, progression, and replacement policy; external `CAP-D11` remains the owner of offline legacy recovery.

---

## Phase 1: Persist and Reload Tagged Runtime Aggregates

Establish one complete durable aggregate boundary for both document and implementation stages. A caller can insert valid StageRun and tagged StageRevision data through typed store primitives and reload the same identities, pointers, ordered steps, references, diagnostics, and physical-operation ownership; malformed local or semantic shapes fail before use.

### File Changes

- **`src/qrspi/stage-runtime.ts`**: Define strict runtime identities, lifecycle states, tagged document and implementation revision records, ordered implementation steps, immutable artifact/commit/checkpoint references, operation ownership, Generation cursor values, diagnostic details, and typed stale/incompatible outcomes. Compose existing exact stage scope and source Schemas here to avoid reversing the current `contracts/common.ts` to `domain.ts` dependency.
- **`src/qrspi/domain.ts`**: Export any foundational bounded identifiers or shared hash/reference primitives needed by the runtime module without importing contract modules back into the domain foundation.
- **`src/qrspi/contracts/common.ts`**: Reuse or narrowly extend `ArtifactReference`, exact source-set, and stage-scope Schemas where the durable record requires an identity already owned by the contract boundary; do not create a second competing shape.
- **`src/store/migrations.ts`**: Add the next numbered append-only migration for strict StageRun, common revision, tagged payload, implementation-step, immutable-reference, operation-ownership, and revision-diagnostic tables; add Generation cursor columns and permit `stage_runtime_v1`. Enforce local keys, one-to-one variant associations, positive ordinals, foreign keys, state literals, and partial one-current-row indexes while retaining a runner at the pre-runtime frontier.
- **`src/qrspi/store.ts`**: Add runtime row Schemas, strict JSON decoding with excess-property rejection, relational identity and tag comparisons, ordered-child checks, canonical hash validation, and typed create/read methods on `QrspiStorePort`.
- **`test/store/migrations.test.ts`**: Verify migration order, `STRICT` tables, checks, composite foreign keys, one-to-one variant ownership, Generation cursors, format literals, and partial indexes; reject invalid tags, cross-variant payloads, duplicate current rows, malformed JSON, and invalid ordinals.
- **`test/qrspi/store.test.ts`**: Add a real-SQLite harness and round-trip one document aggregate and one implementation aggregate, including ordered steps and exact ownership; inject malformed, missing, duplicate, reordered, identity-mismatched, and hash-mismatched rows and assert bounded typed diagnostics before any transition.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts test/qrspi/store.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Inspect the migrated schema and store port together to confirm every durable foreign-key or identity seam has a named current-ticket or downstream owner and no owner lifecycle, status, or capacity state was introduced.

---

## Phase 2: Fence Runtime Transitions and Replace Revisions

Establish the reusable guarded store transition boundary before bootstrap depends on it. Using valid runtime aggregates created through Phase 1, each transition moves the exact run, revision, pointer, operation, reference, and parent state together, and the replacement primitive allocates a higher StageRevision while preserving prior and terminal history. Downstream owners call these primitives without transferring their lifecycle policy to D3.

### File Changes

- **`src/qrspi/stage-runtime.ts`**: Add typed expected-authority inputs and results for run/revision lifecycle changes, pointer installation or clearing, reference insertion, operation ownership, implementation-step position, and revision replacement.
- **`src/qrspi/store.ts`**: Implement transaction-scoped compare-and-set methods that decode all participating rows and recheck current Generation/format, repository and definitions, current run/state, pending/published/accepted pointers, revision tag/source hash, step position, current physical operation revision/attempt, lease token/expiry, and bound intent/observation or SHA where applicable.
- **`src/qrspi/store.ts`**: Add monotonic StageRevision replacement using `max(stage_revision) + 1`; preserve prior rows, retire only allowed nonterminal work, clear every expected prior pointer, insert exact replacement ownership and references, and install the new pending pointer. Keep `retry_of` reserved for WorkflowOperation retry rather than StageRevision replacement.
- **`test/qrspi/store.test.ts`**: Add a table-driven stale matrix that changes each authority dimension independently and asserts typed stale, unchanged before-state, no weaker retry, and no child, pointer, reference, operation, or parent effect. Cover allowed document and implementation transitions, reference insertion, ordered step progression, replacement history, stale accepted-pointer rejection, rollback injection, and exact reload after stale.

```typescript
replaceStageRevision(input: ReplaceStageRevisionInput): Effect.Effect<
  StageRevisionAggregate,
  SqlError | QrspiStoreDataError | QrspiStoreStaleError
>
```

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/store.test.ts`
- [ ] `bun test test/qrspi/source-assembly.test.ts test/qrspi/contracts.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Compare every state-changing public method with the accepted authority checklist and confirm no precheck is followed by a weaker unguarded mutation.

---

## Phase 3: Bootstrap One Fresh Generation into Claimable Runtime

Connect existing WorkflowStart output to the new runtime without moving CAP-D7 policy into WorkflowStart. Given caller-selected exact records, one guarded transaction reuses the Phase 2 fencing contract to verify current snapshots and untouched placeholders, retain placeholder history, install higher non-retry operation revisions and exact ownership, move expected pointers, change the format, and expose only the complete runtime to stage claims.

### File Changes

- **`src/qrspi/stage-runtime.ts`**: Add the exact bootstrap request/result and claim authority Schemas, including selected runs, skipped records, initial revisions or steps, sources, operation inputs, expected placeholders, and complete installed identity.
- **`src/qrspi/store.ts`**: Add the idempotent bootstrap transaction and format-aware stage claim/read methods on the Phase 2 compare-and-set boundary. Require the current `stage_snapshots_v1` Generation, matching snapshots, exact untouched placeholder revisions and hashes, no placeholder lease/gate answer/output/intent/uncertain observation, strict caller input decoding, expected pointers, and zero partial runtime rows. Supersede placeholders, create higher revisions without `retry_of`, install runtime ownership and pointers, and set `stage_runtime_v1` atomically. Exact duplicate runtime state returns the installed result; changed or partial state returns typed stale/incompatible.
- **`src/qrspi/store.ts`**: Expand current snapshot preflight to validate both `stage_snapshots_v1` and `stage_runtime_v1` snapshot-bearing Generations while keeping `legacy`, partial, unsupported, and unowned work nonclaimable.
- **`test/qrspi/store.test.ts`**: Start from real WorkflowStart-shaped placeholders and prove they cannot be claimed, exact bootstrap commits all rows together, placeholders remain immutable superseded history, replacement operations have no retry lineage, only exact runtime ownership is claimable, duplicates converge, identity changes fail, and injected transaction faults leave the complete pre-bootstrap state.
- **`test/qrspi/workflow-start.test.ts`**: Preserve existing WorkflowStart Generation replacement and placeholder assertions, and add only the integration assertions needed to show that WorkflowStart remains unchanged and its output is a nonclaimable bootstrap source.
- **`test/qrspi/stage-replay.test.ts`**: Verify exact post-bootstrap `StageProduceInput` replay through a fresh store instance while retaining rejection of the legacy-shaped placeholder input.

```typescript
bootstrapStageRuntime(input: BootstrapStageRuntimeInput): Effect.Effect<
  StageRuntimeBootstrap,
  SqlError | QrspiStoreDataError | QrspiStoreStaleError | QrspiStoreIncompatibleError
>
```

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/store.test.ts test/qrspi/workflow-start.test.ts test/qrspi/stage-replay.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Review the bootstrap transaction trace to confirm it uses the Phase 2 fencing boundary, CAP-D7 supplies selection policy, WorkflowStart still creates only snapshots and placeholders, and no placeholder can reach a stage claimer before the format and ownership commit.

---

## Phase 4: Quarantine Corrupt Runtime Aggregates

Contain readable corrupt mutable revisions as one durable terminal aggregate. The transaction creates or recovers one bounded diagnostic, abandons the revision, terminates the run as `data_error`, clears current authority, disposes only safe child work, preserves uncertain-effect evidence and custody, and releases no successor or replacement.

### File Changes

- **`src/qrspi/stage-runtime.ts`**: Finalize bounded quarantine reason/details Schemas and the typed terminal aggregate result without adding `data_error` to the normative StageRevision state set.
- **`src/qrspi/store.ts`**: Extend data-error classification to StageRun/StageRevision records and implement guarded aggregate quarantine. Handle nonterminal mutable revision corruption through `StageRevision.abandoned` plus `StageRun.data_error`; cancel pending gates, clear leases and producer mutation authority, supersede only children with safe known outcomes, retain intent/observation/commit/workspace custody for uncertain effects, retain the Generation cursor on the stalled run, and make identical quarantine idempotent. Record diagnostics but do not rewrite terminal history or corrupt immutable authority.
- **`test/qrspi/store.test.ts`**: Add a real-SQLite corruption matrix for malformed/excess JSON, missing/duplicate/reordered children, wrong tags, relational identity mismatch, and canonical hash mismatch. Assert one diagnostic, exact terminal states, pointer clearing, safe child and gate effects, uncertain evidence retention, no successor/replacement, idempotence, stale rollback, terminal immutability, and reopen recovery.
- **`test/qrspi/stage-replay.test.ts`**: Keep WorkflowOperation-native quarantine coverage and add boundary checks showing when corruption routes to operation quarantine, revision aggregate quarantine, or immutable-authority blockage.

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/store.test.ts test/qrspi/stage-replay.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`

#### Manual Verification

- [ ] Inspect uncertain-effect fixtures to confirm quarantine retains evidence and custody only for later observation, never as authority to advance, replace, or release a successor.

---

## Phase 5: Prove Upgrade and Restart Boundaries

Close the capability with file-backed proof across the previous migration frontier and every supported current format. Legacy facts remain byte-for-byte unchanged and fail closed, pre-runtime bootstrap resumes safely, runtime authority reloads exactly, and quarantined state remains terminal after a fresh layer opens the same database.

### File Changes

- **`src/store/migrations.ts`**: Export the pre-runtime migration runner used by deterministic upgrade fixtures and keep the current runner append-only.
- **`src/qrspi/store.ts`**: Complete format-specific read/preflight diagnostics for `legacy`, `stage_snapshots_v1`, `stage_runtime_v1`, and partial/incompatible rows; ensure restart loaders return exact current pointers, ownership, leases, intent, observations, bootstrap identity, and diagnostics without inferred facts.
- **`test/store/migrations.test.ts`**: Create a previous-frontier file database, seed shipped Generation/operation history, apply current migrations, and prove old identities and values remain unchanged while every new table, index, cursor, and format rule exists.
- **`test/qrspi/store.test.ts`**: Reopen fresh Effect layers around the same SQLite file for pre-bootstrap, post-bootstrap, active lease/intent/observation, replacement history, and quarantined aggregate fixtures. Prove only complete `stage_runtime_v1` ownership is claimable and exact retry/reload never duplicates history.
- **`test/qrspi/workflow-start.test.ts`**: Retain existing file-backed WorkflowStart upgrade/restart cases as regression coverage for unchanged kickoff behavior and both snapshot-bearing preflight formats.

### Validation

#### Automated Verification

- [ ] `bun test test/store/migrations.test.ts test/qrspi/store.test.ts test/qrspi/workflow-start.test.ts test/qrspi/stage-replay.test.ts test/qrspi/contracts.test.ts test/qrspi/source-assembly.test.ts`
- [ ] `bun run check`

#### Manual Verification

- [ ] Review the final diff against the accepted exclusions and confirm it adds no stage selection/progression policy, producer or publisher execution, TargetReconcile or handoff lifecycle, status/readiness, capacity control, online legacy conversion, or inferred historical authority.

---

## Open Questions

- None. Design revision 3 resolved the bootstrap, quarantine, ownership, migration, and verification decisions, and the human authorized the recommended answer at each local review gate.

## Local Authority Limitation

This outline uses the confirmed content-addressed local graph export at `03-provenance-promotion-result-r3-graph-export.json` as the explicitly authorized snapshot substitute in local-QRSPI compatibility mode. It does not claim production Provenance publication, authenticated production gate authority, a production graph root, or production Structure authority.

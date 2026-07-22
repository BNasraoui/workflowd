# Structure: Configurable QRSPI stages and artifact publication

## Binding and deviation

This Structure projection is bound to WorkflowId `BNasraoui/workflowd:workflowd-vs3.4`, Generation `1`, accepted Design revision `4`, package `bac9e02e7016aa3135b5cd0913003b6fe10d2ed8ece8f9c39a695e6e3d13da43`, gate response `8b1c1716b4fdb20adfb5d6f574a552b8371c9bb4229ea380ef4553a895987ea3`, promotion request revision `2` / `05ae3095720d80c5e8c0ffb637faae94a842dac77678bcd50dc81100768354a7`, promotion result `24992360d99435017746cb55d661817e3b8d0ea27c4c1b0a1ede734ef3f3dfe5`, and Structure policy `workflowd.structure@1` / `d360ea62f9b7e1847c0da5b630af93fd28f98fb7f58e88d7b5f026be5922b85d`.

The immutable Provenance graph snapshot/version identity is unavailable. Ben Nasraoui manually authorized Structure projection from `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-provenance-graph-export-r4.json`, whose verified byte SHA-256 is `f8bd728183d02da4b79db6448cf8dbd3403a0e79e2bf39008d1d20efd4133977`. This artifact is manually bound to that content-addressed export and is not backed by an immutable Provenance snapshot/version identity. The authorization does not relax semantic coverage, ownership, or implementation-readiness checks.

This selected canonical artifact incorporates the evidence-rule clarifications from four
independent Structure producers. A planned future dependency seam is not current repository
evidence, and a complete named seam must already name and accept every direct dependency
interface.

`ImplementationReady` requires every checklist row for a capability to pass. Any failed row makes that capability `SplitFlowRequired`. Current repository code, not Design completeness, supplies the checklist evidence.

## CAP-D1: Trusted definitions and catalog

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d1`; `needs_requirement_wvs34-d4-bac9e02e-req-ac1_to_resolution_wvs34-d4-bac9e02e-res-d1`; `resolves_resolution_wvs34-d4-bac9e02e-res-d1_to_requirement_wvs34-d4-bac9e02e-req-ac1`; `produces_resolution_wvs34-d4-bac9e02e-res-d1_to_rule_wvs34-d4-bac9e02e-rule-c1`.

**Dependencies:** Existing QRSPI definition Schema and configuration decode.

**Outcome:** Server-owned hashed definitions resolve trusted versioned stage contracts and harnesses through one validated catalog seam before claim.

**Verification ownership:** `workflowd-vs3.4`; V1 at configuration, Layer, restart, and activation boundaries.

**Likely files/modules:** `src/config.ts`, `src/qrspi/domain.ts`, `src/qrspi/catalog.ts`, `src/layers.ts`, `test/config.test.ts`, `test/layers.test.ts`, `test/qrspi/catalog.test.ts`.

**Out of scope:** Repository registration, per-stage Context tags, owner lifecycles, operational status, and aggregate capacity policy.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `normalizeWorkflowDefinition` in `src/qrspi/domain.ts:251` validates descriptor shape, but no `StageCatalog` or contract/harness resolution seam exists. |
| No new module/interface | Fail | `src/qrspi/ports.ts` exposes only ticket and repository ports; catalog and stable contract-reference interfaces are absent. |
| No new transaction boundary | Pass | Definition and catalog validation is pre-claim local validation; no atomic state change is inherent to this capability. |
| No new durable record/schema/migration | Fail | `qrspi_workflow_definitions` in `src/store/migrations.ts:411` stores only definition JSON; executable stage snapshots and registration identity are absent. |
| No new lifecycle/state machine | Pass | Catalog resolution is validation and dispatch, not an independently durable lifecycle. |
| No uncertain external/cross-owner effect | Pass | Definitions and trusted registrations are server-local values. |
| No multi-resource recovery/fault fixture | Pass | V1 needs configuration and Layer activation evidence, not coordinated resource recovery. |

**Disposition:** `SplitFlowRequired`.

## CAP-D2: Six exact typed stage contracts

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d2`; `needs_requirement_wvs34-d4-bac9e02e-req-ac2_to_resolution_wvs34-d4-bac9e02e-res-d2`; `resolves_resolution_wvs34-d4-bac9e02e-res-d2_to_requirement_wvs34-d4-bac9e02e-req-ac2`; `produces_resolution_wvs34-d4-bac9e02e-res-d2_to_rule_wvs34-d4-bac9e02e-rule-c2`.

**Dependencies:** CAP-D1.

**Outcome:** Questions, Research, Design, Structure, Plan, and Implementation each decode a distinct bounded request/result contract and persist exact authority-ordered sources and request identity.

**Verification ownership:** `workflowd-vs3.4`; V2 and the built-in registration, extension, order, and source-authority matrix.

**Likely files/modules:** `src/qrspi/domain.ts`, `src/qrspi/catalog.ts`, `src/qrspi/contracts/`, `src/qrspi/store.ts`, `test/qrspi/contracts.test.ts`.

**Out of scope:** Agent execution, publication, review, gate, Provenance mutation, Plan execution, and Implementation execution.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `WorkflowStageDefinition` in `src/qrspi/domain.ts:222` names one generic input descriptor; no built-in request/result contracts exist. |
| No new module/interface | Fail | Distinct contract Schemas, request assembly, task construction, and output projection interfaces are absent. |
| No new transaction boundary | Fail | `src/qrspi/store.ts` has no atomic revision/request persistence seam for exact source bytes and hashes. |
| No new durable record/schema/migration | Fail | Current migrations have no stage-definition snapshot, stage revision, or persisted typed request records. |
| No new lifecycle/state machine | Pass | The six contracts are trusted values; their execution lifecycle belongs to later capabilities. |
| No uncertain external/cross-owner effect | Pass | Immutable source reads and Schema decoding do not mutate an external owner. |
| No multi-resource recovery/fault fixture | Pass | V2 can be proved at Schema and SQLite persistence boundaries. |

**Disposition:** `SplitFlowRequired`.

## CAP-D3: Durable tagged runtime model

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d3`; `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d3`; `resolves_resolution_wvs34-d4-bac9e02e-res-d3_to_requirement_wvs34-d4-bac9e02e-req-ac9`; `produces_resolution_wvs34-d4-bac9e02e-res-d3_to_rule_wvs34-d4-bac9e02e-rule-c4`.

**Dependencies:** CAP-D1 and CAP-D2.

**Outcome:** Strict tagged stage records and the shared operation lifecycle durably guard leases, pointers, diagnostics, currentness, quarantine, and restart.

**Verification ownership:** `workflowd-vs3.4`; V3 and stale/data-error/restart transaction tests.

**Likely files/modules:** `src/qrspi/domain.ts`, `src/qrspi/store.ts`, `src/store/migrations.ts`, `test/qrspi/store.test.ts`, `test/store/migrations.test.ts`.

**Out of scope:** Stage-specific workers, owner stores, generic PR reconciliation, and status projection.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `workflow_operations` and `qrspi_generations` exist at `src/store/migrations.ts:423` and `:502`, but stage runs, revisions, steps, references, handoffs, and reconciliation records do not. |
| No new module/interface | Fail | Current domain and store APIs do not expose tagged document/implementation revisions or guarded stage transitions. |
| No new transaction boundary | Fail | Atomic run/revision pointer and parent-effect transitions are new store transactions. |
| No new durable record/schema/migration | Fail | The accepted runtime model requires durable stage and reference records absent from current migrations. |
| No new lifecycle/state machine | Fail | StageRun and StageRevision lifecycles are not implemented in the repository. |
| No uncertain external/cross-owner effect | Fail | The shared model must represent and fence uncertain external intents and owner results. |
| No multi-resource recovery/fault fixture | Fail | Restart and post-effect currentness need SQLite plus controlled external-effect fixtures. |

**Disposition:** `SplitFlowRequired`.

## CAP-D4: Linear production and custody handoff

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d4`; `needs_requirement_wvs34-d4-bac9e02e-req-ac7_to_resolution_wvs34-d4-bac9e02e-res-d4`; `resolves_resolution_wvs34-d4-bac9e02e-res-d4_to_requirement_wvs34-d4-bac9e02e-req-ac7`; `produces_resolution_wvs34-d4-bac9e02e-res-d4_to_rule_wvs34-d4-bac9e02e-rule-c3`; `produces_resolution_wvs34-d4-bac9e02e-res-d4_to_rule_wvs34-d4-bac9e02e-rule-c5`.

**Dependencies:** CAP-D1, CAP-D2, and CAP-D3.

**Outcome:** One producer path checkpoints launch and session identity, validates output in an attempt workspace, atomically transfers immutable custody, and fences cleanup and late output.

**Verification ownership:** `workflowd-vs3.4` using `workflowd-vs3.2` harness mechanics; V3.

**Likely files/modules:** `src/agent-harness.ts`, `src/qrspi/producer.ts`, `src/qrspi/store.ts`, `src/workspace/`, `test/agent-harness.test.ts`, `test/qrspi/producer.test.ts`.

**Out of scope:** Harness publication authority, session presentation/retention policy, artifact publication, and aggregate workspace capacity control.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `src/agent-harness.ts` supplies session mechanics, but no QRSPI producer joins them to StageRevision state or workspace custody. |
| No new module/interface | Fail | No QRSPI producer/custody service exists. |
| No new transaction boundary | Fail | Producer completion must atomically bind output and custody to blocked publication; current store has no such transaction. |
| No new durable record/schema/migration | Fail | Agent execution checkpoints and stage custody records are absent from current migrations. |
| No new lifecycle/state machine | Fail | Launch, session, output, cleanup, and custody progression is new durable lifecycle behavior. |
| No uncertain external/cross-owner effect | Fail | OpenCode session creation/resume/abort and filesystem custody can fail with uncertain timing. |
| No multi-resource recovery/fault fixture | Fail | V3 coordinates SQLite, OpenCode session behavior, leases, and workspaces under faults. |

**Disposition:** `SplitFlowRequired`.

## CAP-D5: Exact artifact publication

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d5`; `needs_requirement_wvs34-d4-bac9e02e-req-ac8_to_resolution_wvs34-d4-bac9e02e-res-d5`; `resolves_resolution_wvs34-d4-bac9e02e-res-d5_to_requirement_wvs34-d4-bac9e02e-req-ac8`; `produces_resolution_wvs34-d4-bac9e02e-res-d5_to_rule_wvs34-d4-bac9e02e-rule-c6`; `produces_resolution_wvs34-d4-bac9e02e-res-d5_to_rule_wvs34-d4-bac9e02e-rule-c7`.

**Dependencies:** CAP-D3 and CAP-D4.

**Outcome:** A dedicated publisher verifies custody and candidate bytes, creates one signed sole-parent commit, persists intent, performs exact-old fast-forward update, and completes only after authoritative observation.

**Verification ownership:** `workflowd-vs3.4`; V4 at real Git and SQLite boundaries.

**Likely files/modules:** `src/qrspi/publisher.ts`, `src/qrspi/store.ts`, `src/qrspi/ports.ts`, `src/workspace/git.ts`, `test/qrspi/publisher.test.ts`.

**Out of scope:** Pull-request publication, artifact presentation, force push, ref reset, and Provenance publication.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `src/workspace/fix.ts:38` publishes fix work, but its ordinary `git push` at `:101` is not exact-old compare-and-set and is not a QRSPI publisher. |
| No new module/interface | Fail | `QrspiArtifactPublisher` and exact update/observation ports are absent. |
| No new transaction boundary | Fail | Intent persistence and observed completion with cursor/reference updates require new guarded transactions. |
| No new durable record/schema/migration | Fail | Final-SHA intent, observation, artifact references, and custody bindings are not stored. |
| No new lifecycle/state machine | Fail | Publication intent, waiting-external, observation, completion, and conflict routing are not implemented for QRSPI. |
| No uncertain external/cross-owner effect | Fail | Remote Git mutation has explicit unknown-result and stale-post-effect cases. |
| No multi-resource recovery/fault fixture | Fail | V4 requires real Git, SQLite, transaction faults, and restart windows. |

**Disposition:** `SplitFlowRequired`.

## CAP-D6: Publication-scoped reconciliation

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d6`; `needs_requirement_wvs34-d4-bac9e02e-req-ac8_to_resolution_wvs34-d4-bac9e02e-res-d6`; `resolves_resolution_wvs34-d4-bac9e02e-res-d6_to_requirement_wvs34-d4-bac9e02e-req-ac8`; `produces_resolution_wvs34-d4-bac9e02e-res-d6_to_rule_wvs34-d4-bac9e02e-rule-c8`; `produces_resolution_wvs34-d4-bac9e02e-res-d6_to_rule_wvs34-d4-bac9e02e-rule-c9`.

**Dependencies:** CAP-D3 and CAP-D5.

**Outcome:** Publication conflicts, rollback, stale effects, and ambiguous observations enter one durable read-only reconciliation and accept only exact typed resolutions.

**Verification ownership:** `workflowd-vs3.4`; V4 and V5.

**Likely files/modules:** `src/qrspi/reconcile.ts`, `src/qrspi/domain.ts`, `src/qrspi/store.ts`, `src/store/migrations.ts`, `test/qrspi/reconcile.test.ts`.

**Out of scope:** Destructive Git repair, generic PR reconciliation, status aggregation, and arbitrary operator mutation.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `TargetReconcile` is only an allowed operation kind in `src/store/migrations.ts:430`; no QRSPI reconciliation implementation or record exists. |
| No new module/interface | Fail | Typed reconciliation input, observation, and resolution interfaces are absent. |
| No new transaction boundary | Fail | Atomic conflict capture, parent-state save, publication blocking, and resolution application are new transactions. |
| No new durable record/schema/migration | Fail | No `qrspi_target_reconciliations`-equivalent record stores bound evidence and resolution. |
| No new lifecycle/state machine | Fail | Publication-scoped reconciliation is a new durable lifecycle. |
| No uncertain external/cross-owner effect | Fail | It exists specifically to resolve uncertain or conflicting Git truth. |
| No multi-resource recovery/fault fixture | Fail | V4/V5 combine Git observation, SQLite state, resolution, transaction failure, and restart. |

**Disposition:** `SplitFlowRequired`.

## CAP-D7: Accepted-only progression

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d7`; `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d7`; `resolves_resolution_wvs34-d4-bac9e02e-res-d7_to_requirement_wvs34-d4-bac9e02e-req-ac9`.

**Dependencies:** CAP-D2, CAP-D3, CAP-D4, CAP-D5, and CAP-D6.

**Outcome:** Linear progression consumes accepted revisions only, preserves distinct document and implementation shapes, observes contiguous implementation commits, replaces failed revisions monotonically, and makes no stage PR call.

**Verification ownership:** `workflowd-vs3.4`; AC10, the progression/revision/checkpoint matrix, and negative PR tests under AC11.

**Likely files/modules:** `src/qrspi/domain.ts`, `src/qrspi/store.ts`, `src/qrspi/runner.ts`, `src/store/migrations.ts`, `test/qrspi/progression.test.ts`, `test/qrspi/implementation.test.ts`.

**Out of scope:** Final verification, final PR publication, arbitrary DAG execution, and reopening terminal history.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | The repository has WorkflowStart but no StageRun progression, document revision, implementation step, or checkpoint seam. |
| No new module/interface | Fail | Distinct revision/checkpoint types and a generic runner interface are absent. |
| No new transaction boundary | Fail | Accepted-pointer release, next-step creation, and revision replacement require new atomic transitions. |
| No new durable record/schema/migration | Fail | Current migrations contain none of the required run, revision, step, commit-reference, or checkpoint records. |
| No new lifecycle/state machine | Fail | Linear run/revision/implementation-step progression is not implemented. |
| No uncertain external/cross-owner effect | Fail | Every implementation commit depends on authoritative Git publication before successor release. |
| No multi-resource recovery/fault fixture | Fail | Revision and checkpoint evidence spans SQLite, workspaces, Git, failures, and restart. |

**Disposition:** `SplitFlowRequired`.

## CAP-D8: Mandatory owner handoffs

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d8`; `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d8`; `resolves_resolution_wvs34-d4-bac9e02e-res-d8_to_requirement_wvs34-d4-bac9e02e-req-ac9`; `produces_resolution_wvs34-d4-bac9e02e-res-d8_to_rule_wvs34-d4-bac9e02e-rule-c10`; `produces_resolution_wvs34-d4-bac9e02e-res-d8_to_rule_wvs34-d4-bac9e02e-rule-c11`; `produces_resolution_wvs34-d4-bac9e02e-res-d8_to_rule_wvs34-d4-bac9e02e-rule-c13`.

**Dependencies:** CAP-D1, CAP-D3, and CAP-D7.

**Outcome:** Required owner capabilities are validated before exposure and each crossing uses one durable deterministic local receipt that resumes by the same identity.

**Verification ownership:** `workflowd-vs3.4` for V6 and local V7; selected `workflowd-vs3.5`, `workflowd-vs3.6`, `workflowd-vs3.9`, or `workflowd-vs3.14` for C13 owner-side contract evidence.

**Likely files/modules:** `src/qrspi/handoff-catalog.ts`, `src/qrspi/domain.ts`, `src/qrspi/store.ts`, `src/layers.ts`, `test/qrspi/handoff.test.ts`, `test/layers.test.ts`.

**Out of scope:** Neighbor queues, stores, retries, review/gate/Provenance/route lifecycles, status signals, and owner work claiming.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | No `QrspiHandoffCatalog`, owner capability reference, or durable stage handoff exists. |
| No new module/interface | Fail | Availability, submit, and observe interfaces must be introduced. |
| No new transaction boundary | Fail | A crossing must atomically persist its exact receipt before submission and apply matching results under currentness. |
| No new durable record/schema/migration | Fail | Current migrations have no handoff receipt, delivery attempt, observation, or response record. |
| No new lifecycle/state machine | Fail | Pending delivery, unavailable capability, observation, and terminal receipt states are new. |
| No uncertain external/cross-owner effect | Fail | This capability crosses four named owner boundaries and must recover uncertain delivery. |
| No multi-resource recovery/fault fixture | Fail | V7 requires SQLite, replaceable owner adapters, failure, restart, restoration, duplicate, and mismatch cases. |

**Disposition:** `SplitFlowRequired`.

## CAP-D9: Exact Design owner effects

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d9`; `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d9`; `resolves_resolution_wvs34-d4-bac9e02e-res-d9_to_requirement_wvs34-d4-bac9e02e-req-ac9`; `produces_resolution_wvs34-d4-bac9e02e-res-d9_to_rule_wvs34-d4-bac9e02e-rule-c12`; `produces_resolution_wvs34-d4-bac9e02e-res-d9_to_rule_wvs34-d4-bac9e02e-rule-c14`.

**Dependencies:** CAP-D2, CAP-D3, CAP-D7, and CAP-D8.

**Outcome:** Exact typed review/gate results drive only allowed local effects; approval constructs one promotion request; only a matching confirmed result and snapshot release Structure; only a bounded `workflowd-vs3.14` directive selects reentry effects.

**Verification ownership:** `workflowd-vs3.4` for V11 local validation/application; `workflowd-vs3.5`, `workflowd-vs3.6`, `workflowd-vs3.9`, and `workflowd-vs3.14` retain their owner-side lifecycle evidence.

**Likely files/modules:** `src/qrspi/design-integration.ts`, `src/qrspi/domain.ts`, `src/qrspi/store.ts`, `src/store/migrations.ts`, `test/qrspi/design-integration.test.ts`.

**Out of scope:** Review ordering/synthesis, gate lifecycle/transport, Provenance mutation/observation, semantic classification/closure/selection, and graph snapshot production.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | No Design acceptance, promotion, StructureInput, or reentry application seam exists in current QRSPI code. |
| No new module/interface | Fail | Exact package, response, promotion, snapshot, and directive result Schemas are absent. |
| No new transaction boundary | Fail | Approval application/request creation, confirmed release, and reentry application each require guarded atomic state effects. |
| No new durable record/schema/migration | Fail | Current migrations store no Design integration or reentry application receipts. |
| No new lifecycle/state machine | Fail | Specialized Design acceptance and reentry alter the current linear stage lifecycle. |
| No uncertain external/cross-owner effect | Fail | Results cross `.5`, `.6`, `.9`, and `.14`; absent, partial, conflicting, and uncertain outcomes must remain blocked. |
| No multi-resource recovery/fault fixture | Fail | V11 needs owner adapters, SQLite transactions, exact identities, duplicate delivery, and stale-result fixtures. |

**Disposition:** `SplitFlowRequired`.

## CAP-D10: Single runtime composition

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d10`; `needs_requirement_wvs34-d4-bac9e02e-req-ac3_to_resolution_wvs34-d4-bac9e02e-res-d10`; `resolves_resolution_wvs34-d4-bac9e02e-res-d10_to_requirement_wvs34-d4-bac9e02e-req-ac3`.

**Dependencies:** CAP-D1 through CAP-D9 and CAP-D11.

**Outcome:** The existing live Layer and supervision model compose one catalog, handoff catalog, store, stage service, publisher, and QRSPI loop; QRSPI fails closed without defining service status/readiness.

**Verification ownership:** `workflowd-vs3.4`; V1/V6 Layer and runtime activation tests.

**Likely files/modules:** `src/layers.ts`, `src/runtime.ts`, `src/config.ts`, `src/main.ts`, `test/layers.test.ts`, `test/runtime.test.ts`.

**Out of scope:** A second DI framework, per-stage services/workers, controller readiness, status endpoint, capacity port, and unrelated-worker shutdown.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `makeLiveLayer` in `src/layers.ts:26` and `startHookService` in `src/runtime.ts:100` are generic composition and supervision seams, but they do not yet name or accept the catalog, handoff catalog, stage service, publisher, and operation-loop interfaces required by complete D10. |
| No new module/interface | Pass | This capability composes interfaces introduced by its dependencies rather than defining another product interface. |
| No new transaction boundary | Pass | Layer assembly and worker supervision do not add a durable transaction. |
| No new durable record/schema/migration | Pass | Composition itself adds no durable shape. |
| No new lifecycle/state machine | Fail | `RuntimeWorkerName` in `src/runtime.ts:98` has no QRSPI operation loop; adding its supervised execution is new lifecycle behavior. |
| No uncertain external/cross-owner effect | Pass | Composition validates and starts owned services; uncertainty remains inside the dependent publisher/handoff capabilities. |
| No multi-resource recovery/fault fixture | Pass | Layer/runtime activation can use service substitutions without a recovery drill. |

**Disposition:** `SplitFlowRequired`.

## CAP-D11: Legacy migration and offline recovery

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d11`; `needs_requirement_wvs34-d4-bac9e02e-req-ac5_to_resolution_wvs34-d4-bac9e02e-res-d11`; `resolves_resolution_wvs34-d4-bac9e02e-res-d11_to_requirement_wvs34-d4-bac9e02e-req-ac5`; `produces_resolution_wvs34-d4-bac9e02e-res-d11_to_rule_wvs34-d4-bac9e02e-rule-c15`; `produces_resolution_wvs34-d4-bac9e02e-res-d11_to_rule_wvs34-d4-bac9e02e-rule-c16`; `produces_resolution_wvs34-d4-bac9e02e-res-d11_to_rule_wvs34-d4-bac9e02e-rule-c17`.

**Dependencies:** CAP-D3; ordinary successor kickoff remains owned by `workflowd-vs3.3`.

**Outcome:** Shipped legacy rows remain unchanged; noninteractive preflight, verified backup, append-only apply/rollback, exact offline supersession, and verification precede ordinary successor kickoff.

**Verification ownership:** `workflowd-vs3.4` for V8/V9 recovery tools and fixtures; `workflowd-vs3.3` for ordinary authenticated WorkflowStart behavior.

**Likely files/modules:** `src/cli/qrspi-upgrade.ts`, `src/store/migrations.ts`, `src/qrspi/upgrade.ts`, `src/qrspi/store.ts`, `src/main.ts`, `test/qrspi/upgrade.test.ts`, `test/store/migrations.test.ts`.

**Out of scope:** Legacy fact inference/conversion, direct SQL recovery, route-state import, Git/Provenance inference, and successor creation by migration code.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `runStoreMigrations` in `src/store/migrations.ts:575` applies migrations automatically; no offline preflight/apply/resolve/verify seam exists. |
| No new module/interface | Fail | Operator commands, manifest Schema, backup adapter, and exact resolution interface are absent. |
| No new transaction boundary | Fail | Append-only apply and exact supersession require new guarded transactions. |
| No new durable record/schema/migration | Fail | Upgrade manifests, classifications, backup evidence, and resolution receipts are not stored. |
| No new lifecycle/state machine | Fail | Preflight, apply, resolve, and verify form a durable recovery workflow absent from current code. |
| No uncertain external/cross-owner effect | Fail | Database/WAL/SHM backup, fsync, restore, and process restart can fail between resources; successor kickoff crosses to `.3`. |
| No multi-resource recovery/fault fixture | Fail | V8/V9 require versioned file databases, filesystem backup, injected failures, CLI process boundaries, and service restart. |

**Disposition:** `SplitFlowRequired`.

## CAP-D12: Lowest-boundary behavioral verification

**Authority and full exact export edge IDs:** `wvs34-d4-bac9e02e-res-d12`; `needs_requirement_wvs34-d4-bac9e02e-req-ac11_to_resolution_wvs34-d4-bac9e02e-res-d12`; `resolves_resolution_wvs34-d4-bac9e02e-res-d12_to_requirement_wvs34-d4-bac9e02e-req-ac11`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v1`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v10`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v11`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v2`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v3`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v4`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v5`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v6`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v7`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v8`; `produces_requirement_wvs34-d4-bac9e02e-req-ac11_to_rule_wvs34-d4-bac9e02e-rule-v9`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v1`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v10`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v11`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v2`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v3`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v4`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v5`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v6`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v7`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v8`; `produces_resolution_wvs34-d4-bac9e02e-res-d12_to_rule_wvs34-d4-bac9e02e-rule-v9`.

**Dependencies:** CAP-D1 through CAP-D11.

**Outcome:** Automated evidence at the lowest reliable boundaries proves V1-V11, all acceptance scenarios, no-PR behavior, owner availability/recovery, exact Git reconciliation, upgrade recovery, revisions, and implementation checkpoint handoff.

**Verification ownership:** `workflowd-vs3.4` owns the integrated evidence suite; named downstream owners retain their interface-contract evidence for C13.

**Likely files/modules:** `test/qrspi/`, `test/store/migrations.test.ts`, `test/agent-harness.test.ts`, `test/workspace.test.ts`, `test/layers.test.ts`, `test/runtime.test.ts`, shared Git/SQLite/fault fixtures.

**Out of scope:** Production behavior beyond CAP-D1 through CAP-D11, owner lifecycle implementation, aggregate-capacity guarantees, Plan, and Implementation.

| Checklist row | Result | Current repository evidence |
|---|---|---|
| Existing complete named seam | Fail | `test/qrspi/` covers ticket, adapters, and WorkflowStart only; it has no stage runtime, publication, handoff, reentry, or upgrade matrix. |
| No new module/interface | Pass | This capability adds evidence and fixtures, not a production module or interface. |
| No new transaction boundary | Pass | Tests exercise but do not define production transactions. |
| No new durable record/schema/migration | Pass | Fixtures populate schemas owned by earlier capabilities and add no production durable record. |
| No new lifecycle/state machine | Pass | Tests verify lifecycles owned by earlier capabilities. |
| No uncertain external/cross-owner effect | Fail | V4, V7, and V11 must force uncertain Git and cross-owner outcomes. |
| No multi-resource recovery/fault fixture | Fail | V3, V4, V7, V8, and V9 require coordinated SQLite, Git, filesystem, adapter, process, and restart faults. |

**Disposition:** `SplitFlowRequired`.

## D13 prohibition-only treatment

`wvs34-d4-bac9e02e-res-d13` authorizes no implementation capability. It prohibits an aggregate capacity subsystem, status, recovery policy, deletion rule, or invented owner. Its full exact requirement edges are `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d13` and `resolves_resolution_wvs34-d4-bac9e02e-res-d13_to_requirement_wvs34-d4-bac9e02e-req-ac9`. C18 remains an individual-bound and custody obligation carried by CAP-D1, CAP-D2, and CAP-D4 and verified by CAP-D12; it must not be represented as aggregate-capacity control.

R9 remains accepted, unresolved as an engineering control, and must not be rewritten as resolved. Ben Nasraoui accepted the stated finite-volume cumulative SQLite/workspace exhaustion exposure without aggregate prevention, detection, or recovery control. `workflowd-8bg` is the external follow-up for prevention, detection, containment, and recovery ownership. This Structure creates no capacity capability or duplicate work for that follow-up.

## Semantic classification

The table classifies every semantic record in the verified export. Sources are traceability only; requirements, decisions, controls, and verification obligations receive terminal capability or named external-owner treatment; residual risks retain their accepted dispositions.

| Logical ID | Exact graph ID | Classification | Primary CAP-Dn/external-owner treatment |
|---|---|---|---|
| SRC-binding | `wvs34-d4-bac9e02e-src-binding` | Informational source | Traceability for all CAP-D1 through CAP-D12 |
| SRC-design | `wvs34-d4-bac9e02e-src-design` | Informational source | Traceability for all CAP-D1 through CAP-D12 |
| SRC-gate | `wvs34-d4-bac9e02e-src-gate` | Informational source | CAP-D9 identity; R9 acceptance evidence |
| SRC-impact | `wvs34-d4-bac9e02e-src-impact` | Informational source | CAP-D12 verification/risk traceability |
| SRC-ownership | `wvs34-d4-bac9e02e-src-ownership` | Informational source | External-owner boundary traceability |
| SRC-package | `wvs34-d4-bac9e02e-src-package` | Informational source | CAP-D9 exact package identity |
| SRC-questions | `wvs34-d4-bac9e02e-src-questions` | Informational source | CAP-D2 source traceability |
| SRC-research | `wvs34-d4-bac9e02e-src-research` | Informational source | CAP-D2 source traceability |
| SRC-synthesis | `wvs34-d4-bac9e02e-src-synthesis` | Informational source | C1-C18 and V1-V11 traceability |
| SRC-ticket | `wvs34-d4-bac9e02e-src-ticket` | Product authority source | All CAP-D1 through CAP-D12; ticket remains highest authority |
| AC1 | `wvs34-d4-bac9e02e-req-ac1` | Implementation-bearing requirement | CAP-D1 |
| AC10 | `wvs34-d4-bac9e02e-req-ac10` | Cross-cutting prohibition | CAP-D7; negative verification in CAP-D12 |
| AC11 | `wvs34-d4-bac9e02e-req-ac11` | Verification-bearing requirement | CAP-D12 |
| AC2 | `wvs34-d4-bac9e02e-req-ac2` | Implementation-bearing requirement | CAP-D2 and CAP-D7 |
| AC3 | `wvs34-d4-bac9e02e-req-ac3` | Implementation-bearing requirement | CAP-D1 and CAP-D10 |
| AC4 | `wvs34-d4-bac9e02e-req-ac4` | Cross-cutting type/version rule | CAP-D1 and CAP-D2 |
| AC5 | `wvs34-d4-bac9e02e-req-ac5` | Implementation-bearing requirement | CAP-D1 and CAP-D11 |
| AC6 | `wvs34-d4-bac9e02e-req-ac6` | Implementation-bearing requirement | CAP-D2 |
| AC7 | `wvs34-d4-bac9e02e-req-ac7` | Implementation-bearing requirement | CAP-D4 |
| AC8 | `wvs34-d4-bac9e02e-req-ac8` | Implementation-bearing requirement | CAP-D5 and CAP-D6 |
| AC9 | `wvs34-d4-bac9e02e-req-ac9` | Cross-cutting currentness requirement | CAP-D3, CAP-D7, CAP-D8, and CAP-D9; D13 prohibition applies |
| D1 | `wvs34-d4-bac9e02e-res-d1` | Accepted implementation decision | CAP-D1 |
| D10 | `wvs34-d4-bac9e02e-res-d10` | Accepted implementation decision | CAP-D10 |
| D11 | `wvs34-d4-bac9e02e-res-d11` | Accepted implementation decision | CAP-D11 |
| D12 | `wvs34-d4-bac9e02e-res-d12` | Accepted verification decision | CAP-D12 |
| D13 | `wvs34-d4-bac9e02e-res-d13` | Prohibition-only decision | No capability; prohibit aggregate capacity subsystem |
| D2 | `wvs34-d4-bac9e02e-res-d2` | Accepted implementation decision | CAP-D2 |
| D3 | `wvs34-d4-bac9e02e-res-d3` | Accepted implementation decision | CAP-D3 |
| D4 | `wvs34-d4-bac9e02e-res-d4` | Accepted implementation decision | CAP-D4 |
| D5 | `wvs34-d4-bac9e02e-res-d5` | Accepted implementation decision | CAP-D5 |
| D6 | `wvs34-d4-bac9e02e-res-d6` | Accepted implementation decision | CAP-D6 |
| D7 | `wvs34-d4-bac9e02e-res-d7` | Accepted implementation decision | CAP-D7 |
| D8 | `wvs34-d4-bac9e02e-res-d8` | Accepted implementation decision | CAP-D8 |
| D9 | `wvs34-d4-bac9e02e-res-d9` | Accepted implementation decision | CAP-D9 |
| O1 | `wvs34-d4-bac9e02e-res-o1` | External-owner boundary | `workflowd-vs3.1`; normative contract only |
| O10 | `wvs34-d4-bac9e02e-res-o10` | External-owner boundary | `workflowd-vs3.14`; CAP-D8/D9 seam only |
| O11 | `wvs34-d4-bac9e02e-res-o11` | External-owner boundary | `workflowd-3d8`; status/readiness only, not capacity |
| O2 | `wvs34-d4-bac9e02e-res-o2` | External-owner boundary | `workflowd-vs3.2`; CAP-D4 uses harness mechanics |
| O3 | `wvs34-d4-bac9e02e-res-o3` | External-owner boundary | `workflowd-vs3.3`; CAP-D11 successor kickoff |
| O4 | `wvs34-d4-bac9e02e-res-o4` | Current-ticket ownership | CAP-D1 through CAP-D11 local runtime/effects |
| O5 | `wvs34-d4-bac9e02e-res-o5` | External-owner boundary | `workflowd-vs3.5`; CAP-D8/D9 seam only |
| O6 | `wvs34-d4-bac9e02e-res-o6` | External-owner boundary | `workflowd-vs3.6`; CAP-D8/D9 seam only |
| O7 | `wvs34-d4-bac9e02e-res-o7` | External-owner boundary | `workflowd-vs3.7`; no Structure work |
| O8 | `wvs34-d4-bac9e02e-res-o8` | External-owner boundary | `workflowd-vs3.8`; no Structure work |
| O9 | `wvs34-d4-bac9e02e-res-o9` | External-owner boundary | `workflowd-vs3.9`; CAP-D8/D9 seam only |
| R1 | `wvs34-d4-bac9e02e-res-r1` | Accepted residual risk, NonMaterial under control | CAP-D1 carries C1; CAP-D12 verifies V1 |
| R2 | `wvs34-d4-bac9e02e-res-r2` | Accepted residual risk, NonMaterial under controls | CAP-D2/D4/D3 carry C2-C4; CAP-D12 verifies V2/V3 |
| R3 | `wvs34-d4-bac9e02e-res-r3` | Accepted residual risk, NonMaterial under controls | CAP-D4/D3 carry C3-C5; CAP-D12 verifies V3 |
| R4 | `wvs34-d4-bac9e02e-res-r4` | Accepted residual risk, NonMaterial under controls | CAP-D5/D6 carry C6-C8; CAP-D12 verifies V4 |
| R5 | `wvs34-d4-bac9e02e-res-r5` | Accepted residual risk, NonMaterial under controls | CAP-D5/D6 carry C7-C9; CAP-D12 verifies V4/V5 |
| R6 | `wvs34-d4-bac9e02e-res-r6` | Accepted residual risk, NonMaterial under controls | CAP-D8/D9 carry C10-C13; owner evidence plus CAP-D12 V6/V7 |
| R7 | `wvs34-d4-bac9e02e-res-r7` | Accepted residual risk, NonMaterial under controls | CAP-D3/D9 carry C4/C12/C14; CAP-D12 verifies V11 |
| R8 | `wvs34-d4-bac9e02e-res-r8` | Accepted residual risk, NonMaterial under controls | CAP-D11 carries C15-C17; CAP-D12 verifies V8/V9 |
| R9 | `wvs34-d4-bac9e02e-res-r9` | Accepted residual risk with follow-up | D13 prohibition; C18 in CAP-D1/D2/D4; `workflowd-8bg` external follow-up |
| C1 | `wvs34-d4-bac9e02e-rule-c1` | Accepted cross-cutting control | CAP-D1; CAP-D12 V1 |
| C10 | `wvs34-d4-bac9e02e-rule-c10` | Accepted cross-cutting control | CAP-D8; CAP-D12 V6 |
| C11 | `wvs34-d4-bac9e02e-rule-c11` | Accepted recovery control | CAP-D8; CAP-D12 V7 |
| C12 | `wvs34-d4-bac9e02e-rule-c12` | Accepted cross-cutting control | CAP-D9; CAP-D12 V11 |
| C13 | `wvs34-d4-bac9e02e-rule-c13` | External-owner enabling control | `.5/.6/.9/.14` owner lifecycle; CAP-D8 validates availability |
| C14 | `wvs34-d4-bac9e02e-rule-c14` | Accepted cross-cutting control | CAP-D9; CAP-D12 V11 |
| C15 | `wvs34-d4-bac9e02e-rule-c15` | Accepted upgrade control | CAP-D11; CAP-D12 V8 |
| C16 | `wvs34-d4-bac9e02e-rule-c16` | Accepted upgrade/recovery control | CAP-D11; CAP-D12 V8 |
| C17 | `wvs34-d4-bac9e02e-rule-c17` | Accepted recovery control | CAP-D11; CAP-D12 V9 |
| C18 | `wvs34-d4-bac9e02e-rule-c18` | Accepted individual-bound/custody control | CAP-D1/D2/D4; CAP-D12 V10; never aggregate capacity control |
| C2 | `wvs34-d4-bac9e02e-rule-c2` | Accepted cross-cutting control | CAP-D2; CAP-D12 V2 |
| C3 | `wvs34-d4-bac9e02e-rule-c3` | Accepted execution control | CAP-D4; CAP-D12 V3 |
| C4 | `wvs34-d4-bac9e02e-rule-c4` | Accepted cross-cutting control | CAP-D3; CAP-D12 V3/V11 |
| C5 | `wvs34-d4-bac9e02e-rule-c5` | Accepted custody prohibition | CAP-D4; CAP-D12 V3 |
| C6 | `wvs34-d4-bac9e02e-rule-c6` | Accepted publication control | CAP-D5; CAP-D12 V4 |
| C7 | `wvs34-d4-bac9e02e-rule-c7` | Accepted publication/recovery control | CAP-D5; CAP-D12 V4 |
| C8 | `wvs34-d4-bac9e02e-rule-c8` | Accepted reconciliation control | CAP-D6; CAP-D12 V4 |
| C9 | `wvs34-d4-bac9e02e-rule-c9` | Accepted reconciliation evidence control | CAP-D6; CAP-D12 V5 |
| V1 | `wvs34-d4-bac9e02e-rule-v1` | Verification obligation | CAP-D12 verifies CAP-D1/C1 |
| V10 | `wvs34-d4-bac9e02e-rule-v10` | Verification obligation | CAP-D12 verifies C18 without capacity claim |
| V11 | `wvs34-d4-bac9e02e-rule-v11` | Verification obligation | CAP-D12 verifies CAP-D3/D9/C4/C12/C14 |
| V2 | `wvs34-d4-bac9e02e-rule-v2` | Verification obligation | CAP-D12 verifies CAP-D2/C2 |
| V3 | `wvs34-d4-bac9e02e-rule-v3` | Verification obligation | CAP-D12 verifies CAP-D3/D4/C3-C5 |
| V4 | `wvs34-d4-bac9e02e-rule-v4` | Verification obligation | CAP-D12 verifies CAP-D5/D6/C6-C8 |
| V5 | `wvs34-d4-bac9e02e-rule-v5` | Verification obligation | CAP-D12 verifies CAP-D6/C9 |
| V6 | `wvs34-d4-bac9e02e-rule-v6` | Verification obligation | CAP-D12 verifies CAP-D8/C10 |
| V7 | `wvs34-d4-bac9e02e-rule-v7` | Cross-owner verification obligation | CAP-D12 plus selected owner verifies CAP-D8/C11/C13 |
| V8 | `wvs34-d4-bac9e02e-rule-v8` | Verification obligation | CAP-D12 verifies CAP-D11/C15/C16 |
| V9 | `wvs34-d4-bac9e02e-rule-v9` | Verification obligation | CAP-D12 verifies CAP-D11/C17 |

## Coverage conclusion

The projection accounts for all AC1-AC11, D1-D13, C1-C18, V1-V11, R1-R9, and O1-O11 records in the manually authorized export. CAP-D1 through CAP-D12 are the exact accepted implementation decisions without merge, split, or addition. D13 remains prohibition-only. C13 remains with named downstream owners. R9 remains accepted with `workflowd-8bg` as the external follow-up and no invented capacity owner or capability.

Every CAP-D1 through CAP-D12 has at least one failed repository-evidence checklist row. Therefore none is `ImplementationReady`; all are `SplitFlowRequired`. This artifact does not run split flow or authorize Plan or Implementation.

AwaitingHumanStructureReview

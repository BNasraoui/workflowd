# Post-Structure Scope Review: Persist and Reload Document Runtime Aggregates

## Verdict
`SplitFeature`

## Estimate
estimatedChangedLines:
  low: 2160
  likely: 3360
  high: 4730
confidence: medium
decision: SplitFeature

| Surface | Planned files | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| Production migration and migration registration | `src/store/migrations.ts` | 300 | 420 | 560 |
| Production domain Schemas and semantic filters | `src/qrspi/stage-runtime.ts` (new) | 160 | 240 | 340 |
| Production store port, rows, create/read, and diagnostics | `src/qrspi/store.ts` | 620 | 920 | 1300 |
| Migration and direct-SQL tests | `test/store/migrations.test.ts` | 220 | 380 | 540 |
| Aggregate fixtures, transaction, reload, and corruption tests | `test/qrspi/store.test.ts` (new) | 850 | 1380 | 1950 |
| WorkflowStart inactivity regression | `test/qrspi/workflow-start.test.ts` | 10 | 20 | 40 |
| Configuration | None required by the ticket or Structure | 0 | 0 | 0 |
| Required documentation | None required beyond source/test names; this review does not count planning artifacts | 0 | 0 | 0 |
| **Total** |  | **2160** | **3360** | **4730** |

These are advisory human-authored changed-line estimates. They include additions and substantive edits and exclude generated files, lockfiles, vendored code, and formatter-only churn. All column totals reconcile.

## Evidence
The filtered current ticket defines four implementation-bearing obligations, here labelled for allocation: **A1**, append-only complete shared layout without rewriting legacy rows; **A2**, exact typed document aggregate round trip; **A3**, SQL and Schema rejection of contradictory state before transition; and **A4**, runtime inactivity. Its exclusions remove implementation behavior, claims, progression, replacement, bootstrap, quarantine, external-owner lifecycle, status/readiness, capacity, and legacy conversion. The only reported relationship is parent-child dependency on `workflowd-vs3.4.3`; the ticket is an in-progress task and has one dependent. Tracker notes were not read.

The producer Structure identifies the accepted Design as `.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md`, accepted revision 3, and pins baseline `f8ad7ad9551d0e3513c6800ca2a83b4c49644951`. The checked-out `HEAD` equals that baseline. The Design covers the entire durable tagged runtime model and fixes the controls used here: distinct common/document/implementation records; StageRun-owned pending, published, and accepted pointers; shared physical WorkflowOperation ownership; SQL constraints plus strict Schema/identity/hash checks; append-only migrations and legacy preservation; and inactive seams for neighboring capabilities. This review relies on the Structure's identification of the accepted Design and does not claim or infer production Provenance, authentication, graph, gate, or promotion authority.

### Outcome Inventory

| Structure outcome / parent obligation | Production surface | Test surface | Migration | Config | Docs | Allocation |
| --- | --- | --- | --- | --- | --- | --- |
| Phase 1: historical runner through `0010`; Generation all-or-none cursor; admit `stage_runtime_v1`; preserve all values and infer no runtime rows | `src/store/migrations.ts` | `test/store/migrations.test.ts` file-backed previous-frontier fixture | Numbered post-`0010` migration, including Generation reconstruction if SQLite requires it | None | None | A1; T1 |
| Phase 1: complete strict shared family for runs, common/tagged revisions, implementation steps, immutable references, diagnostics, and document/step operation ownership | `src/store/migrations.ts` | `test/store/migrations.test.ts` shape, key, FK, index, literal, and strictness assertions | Same append-only migration | None | None | A1 and later-sibling shared seam; T1 |
| Phase 1: SQL rejection of bad tags, cross-variant ownership, duplicate current runs/owner keys/operation ownership, cross-run pointers, malformed JSON/hashes, and invalid ordinals | `src/store/migrations.ts` constraints | `test/store/migrations.test.ts` direct-SQL negative matrix | Same append-only migration | None | None | A1 and SQL half of A3; T1 |
| Phase 2: bounded identities, lifecycle/pointers, source identity, document payload, artifact and operation ownership, and tagged aggregate with semantic filters | `src/qrspi/stage-runtime.ts` | `test/qrspi/store.test.ts` fixture decoding and API behavior | None beyond T1 | None | None | A2 and Schema half of A3; T2 |
| Phase 2: typed port and diagnostics vocabulary; strict input and referenced-operation validation; atomic insertion with caller-selected identities | `src/qrspi/store.ts` | `test/qrspi/store.test.ts` create, mismatch, injected failure, and rollback cases | Uses T1 tables | None | None | A2 and pre-write portion of A3; T2 |
| Phase 2: exact identity reload in deterministic order with strict row/JSON decode, relational/nested comparisons, role/tag checks, and canonical hashes | `src/qrspi/store.ts` | `test/qrspi/store.test.ts` exact aggregate equality | Uses T1 tables | None | None | A2 and read portion of A3; T3 |
| Phase 3: exact first bounded diagnostic for missing, malformed, excess, duplicate, reordered, wrong-tag/role/kind, identity, and hash contradictions | `src/qrspi/store.ts` | `test/qrspi/store.test.ts` one-fault-at-a-time corruption matrix | No new migration beyond T1 | None | None | A3; T4 |
| Phase 3: rejected rows remain untouched, no partial trusted aggregate is returned, and existing operation quarantine is not called | `src/qrspi/store.ts` | `test/qrspi/store.test.ts` row snapshots before/after failed reads | None | None | None | A3 and exclusion control; T4 |
| Phase 3: WorkflowStart remains `stage_snapshots_v1` and creates no StageRun/StageRevision; no claim/progression API or executable index is added | No WorkflowStart or worker production change planned | `test/qrspi/workflow-start.test.ts`, plus public-port inspection | T1 omits executable claim indexes/triggers and inserts no rows | None | None | A4 and all inactivity exclusions; T4 |

Every Structure phase, Scope Allocation row, desired-end-state obligation, and ticket acceptance group is represented. No production configuration or required user-facing documentation surface is identified. The new implementation-variant tables are deliberately schema-only; typed implementation payload/step/commit/checkpoint behavior remains excluded.

### Sizing Basis

- `src/store/migrations.ts` is 640 lines at baseline. The existing QRSPI foundation at lines 385-532 uses about 148 lines for five tables and two indexes; the requested migration adds roughly ten strict table families/variants plus composite keys, partial indexes, Generation cursor/format work, and a retained `0010` runner. The 300/420/560 production estimate accounts for denser reuse at the low end and Generation table reconstruction at the high end.
- `test/store/migrations.test.ts` is 833 lines. Migration 9 alone occupies lines 554-833, about 280 lines, for one strict table's structure and a small constraint set. The requested shared family has materially more keys and negative cases, but fixtures can share setup; 220/380/540 reflects that reuse and the required file-backed preservation proof.
- `src/qrspi/store.ts` is 1,513 lines. Its existing strict snapshot reload decoder spans approximately lines 341-516, while strict StageProduce operation decode/hash handling spans lines 547-597. The requested aggregate crosses run, revision, payload, ordered artifacts, and two operations in both create and read directions, adds transaction rollback, and expands exact diagnostics. Reusing these patterns still supports 620/920/1300 changed production lines.
- `src/qrspi/stage-runtime.ts` and `test/qrspi/store.test.ts` do not exist at baseline. The reusable `ExactStageScope`, `ExactStageSources`, `ArtifactReference`, and `PreparedStageOutput.Document` shapes are present in `src/qrspi/contracts/common.ts` (477 lines), reducing domain duplication but not the aggregate-level pointer, lifecycle, ownership, ordering, and hash filters.
- `test/qrspi/workflow-start.test.ts` is 2,317 lines and already contains file-backed previous-frontier patterns around lines 1938-2060 and persisted-format assertions around lines 1643-1651. The inactivity check is therefore a small extension rather than a new harness.
- Comparable repository evidence is source-level rather than commit-size evidence: current strict-table migrations, migration 9's direct-SQL tests, `decodeCurrentGenerationSnapshotSet`, `readStageProduceInput`, `sql.withTransaction`, and the file-backed migration-0008 WorkflowStart fixtures. No prior scope review, tracker note, known implementation diff, or verdict-bearing commit was read.

Confidence is medium: all planned files and comparable patterns are present, the baseline is exact, and the arithmetic is complete. Uncertainty remains in SQLite's format-check reconstruction, the final number/width of shared tables and composite keys, and how many corruption cases can safely share fixtures without obscuring exact diagnostics.

## Scope Signals

| Signal | Evidence | Effect on decision |
| --- | --- | --- |
| Independently useful acceptance groups | A1 supplies the shared schema required by later siblings; A2 supplies document persistence; A3 supplies the trusted-read boundary; A4 proves non-activation. Each has observable SQL/API/test completion and ordered dependencies. | Strong support for splitting implementation work. |
| Multiple durable state machines or external-effect protocols | This child persists StageRun/StageRevision lifecycle literals and operation ownership but intentionally adds no transition, claim, retry, lease, bootstrap, quarantine, or external-effect protocol. | Against epic promotion and against treating this as several runtime features. |
| Distinct trust boundaries | SQLite structural integrity and upgrade preservation, caller/operation validation before write, and durable-row validation before trusted read are distinct boundaries. | Supports dependency-ordered tasks and focused reviews. |
| Reusable framework plus consumers | A1 is a shared relational foundation for this document consumer and later implementation/transition siblings. This ticket exposes only the document consumer. | Supports separating foundation from consumer, but not creating a new epic: the parent already owns the broader capability. |
| Separately releasable or revertible parts | A1 can land inertly and is useful to later siblings. Typed creation, reload, and corruption proof can be staged after it, but incomplete read/write pairs must not be released as production-quality completion and tests cannot be deferred cleanup. | Supports ordered implementation splits with integration gates, not independent product releases. |
| One detailed Design covers the whole change | The accepted ancestor Design fixes record ownership, pointers, tags, operation identity, storage checks, migration behavior, and exclusions for all groups. The Structure reports no open questions. | Strongly against `PromoteToEpic` and `NeedsResearch`. |
| Admission trigger | The parent high estimate is 4,730, far above 1,000. Three top-level subtotals also cross the trigger before recursive decomposition. | Requires an explicit split decision and recursive frontier. |
| Unsafe intermediate-state risk | The migration must remain append-only and complete; atomic create cannot be separated from rollback and exact operation validation; trusted read cannot omit any required contradiction class at final release. | Constrains seams and requires dependency/integration review, but does not make the entire parent indivisible. |

## Decision Rationale
`SplitFeature` fits because this is one coherent feature under one accepted Design, yet it contains several safe, dependency-ordered, independently verifiable implementation outcomes. The complete shared migration is useful while inert; the typed create boundary can be reviewed independently of reload query complexity; valid reload can be established before adversarial durable-row cases; and contradiction/inactivity proof has its own bounded trust-boundary review. Recursive decomposition keeps every proposed frontier leaf below the 1,000-line high-estimate admission trigger while retaining tests and correctness in the same dependency chain.

`FeatureFit` is not credible at a 4,730-line high estimate spanning a complex SQLite upgrade, a new domain model, two store directions, and a large corruption matrix. `PromoteToEpic` is too strong because the groups are not independently designed or prioritizable product features: one Design fixes them, the ticket is already a child of the durable-runtime parent, and document round trip is not complete without the shared schema and trusted read. `KeepLarge` is unnecessary because the safe seams do not require shipped compatibility states or duplicate implementation; dependencies and final integration gates prevent unsafe partial release. `NeedsResearch` is not warranted because the exact baseline, all planned surfaces, relevant patterns, and accepted control decisions are available; remaining variance is represented in the range.

## Proposed Decomposition
The following is advisory and does not mutate the tracker. Every implementation-bearing node and every frontier leaf requires its own independent scope review. None is declared implementation-ready.

### Top-Level Children

| ID | Vertical outcome | Depends on | Primary files | Low | Likely | High | Exact coverage |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| T1 | Install and prove the complete inactive shared runtime layout through one append-only post-`0010` migration | None | `src/store/migrations.ts`, `test/store/migrations.test.ts` | 520 | 800 | 1100 | A1 completely; SQL-local part of A3; Design controls for strict tagged tables, composite same-run keys, unique owner/operation seams, append-only history, format/cursor guard, legacy value preservation, and no inferred rows; risks: SQLite reconstruction, FK/index fidelity, sibling schema completeness |
| T2 | Accept one strict document aggregate and persist it atomically after exact referenced-operation validation | T1 | `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`, `test/qrspi/store.test.ts` | 580 | 860 | 1200 | Write half of A2; pre-write Schema/identity/hash part of A3; controls for caller-selected identities, distinct document tag, producer/publication physical ownership, transaction rollback, no allocation/transition; risks: competing domain shapes, partial rows, accepting mismatched operation authority |
| T3 | Strictly reload one valid document aggregate by complete identity in deterministic order | T2 | `src/qrspi/store.ts`, `test/qrspi/store.test.ts` | 430 | 650 | 900 | Read/round-trip completion of A2; valid-row portion of A3; controls for exact row/JSON decoding, nested/relational equality, deterministic child order, canonical source/prepared/artifact hashes; risks: latest-row inference, silent reorder, partial aggregate exposure |
| T4 | Reject every specified contradictory durable shape without mutation and prove the runtime remains inactive | T3 | `src/qrspi/store.ts`, `test/qrspi/store.test.ts`, `test/qrspi/workflow-start.test.ts` | 630 | 1050 | 1530 | Remaining A3 and all A4; controls for first bounded typed diagnostic, no operation quarantine, no trusted partial return, unchanged WorkflowStart, no claim/transition/bootstrap/quarantine path; risks: diagnostic ambiguity, mutation during read, accidental activation |
| **Top-level total** |  |  |  | **2160** | **3360** | **4730** | All A1-A4 and all Structure phases/exclusions |

### Recursive Frontier

| Frontier ID | Vertical outcome | Depends on | Primary files | Low | Likely | High | Parent allocation and exact coverage | Recursive-review status |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| T1a | Create the full strict table/index/cursor/format layout and historical `0010` runner with structural smoke assertions | None | `src/store/migrations.ts`, `test/store/migrations.test.ts` | 400 | 590 | 800 | Part of T1: all production migration work plus table/column/key/FK/index/literal shape proof; A1 layout and shared-seam controls | Scope review required; not implementation-ready |
| T1b | Prove direct-SQL invariant rejection and exact file-backed `0010` upgrade preservation with zero inferred runtime rows | T1a | `test/store/migrations.test.ts` | 120 | 210 | 300 | Remainder of T1: A1 preservation and SQL rejection evidence; cannot be deferred or released separately from T1a | Scope review required; not implementation-ready |
| T2a | Define the reusable document aggregate Schema boundary and typed port/error vocabulary with strict semantic preflight fixtures | T1 | `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`, `test/qrspi/store.test.ts` | 240 | 350 | 500 | Part of T2: bounded identities, tags, pointers, ordered references, ownership roles, hashes, and no competing source/artifact representation | Scope review required; not implementation-ready |
| T2b | Atomically validate referenced producer/publication operations and insert the complete aggregate, proving mismatch/failure rollback | T2a | `src/qrspi/store.ts`, `test/qrspi/store.test.ts` | 340 | 510 | 700 | Remainder of T2: write half of A2, pre-write A3, operation kind/input/nested-identity controls, all-or-nothing persistence | Scope review required; not implementation-ready |
| T3 | Reload and round-trip the complete valid aggregate with deterministic ordering and canonical identity/hash verification | T2b | `src/qrspi/store.ts`, `test/qrspi/store.test.ts` | 430 | 650 | 900 | Entire T3: completes A2 and establishes the valid trusted-read path needed by corruption tests | Scope review required; not implementation-ready |
| T4a | Diagnose missing, malformed/excess, wrong-tag/role/kind, and relational/nested identity contradictions exactly | T3 | `src/qrspi/store.ts`, `test/qrspi/store.test.ts` | 250 | 390 | 550 | Part of T4: specified `missing`, `malformed`, and `identity_mismatch` coverage with exact record/reason/identity | Scope review required; not implementation-ready |
| T4b | Diagnose duplicate, reordered, and canonical source/prepared/artifact hash contradictions exactly | T4a | `src/qrspi/store.ts`, `test/qrspi/store.test.ts` | 220 | 350 | 500 | Part of T4: specified `duplicate`, `reordered`, and `hash_mismatch` coverage including expected/actual hashes | Scope review required; not implementation-ready |
| T4c | Prove every failed read is non-mutating/non-exposing and regress unchanged WorkflowStart and public runtime inactivity | T4b | `test/qrspi/store.test.ts`, `test/qrspi/workflow-start.test.ts` | 160 | 310 | 480 | Remainder of T4: A4 and containment/exclusion controls; no quarantine call, partial return, runtime rows from WorkflowStart, executable index, or new claim/progression API | Scope review required; not implementation-ready |
| **Frontier total** |  |  |  | **2160** | **3360** | **4730** | Complete allocation of T1-T4 and A1-A4 |  |

### Allocation Accounting

| Allocation class | Low | Likely | High |
| --- | ---: | ---: | ---: |
| T1a + T1b | 520 | 800 | 1100 |
| T2a + T2b | 580 | 860 | 1200 |
| T3 | 430 | 650 | 900 |
| T4a + T4b + T4c | 630 | 1050 | 1530 |
| Shared work outside children | 0 | 0 | 0 |
| Overlapping/double-counted work | 0 | 0 | 0 |
| Separate integration allowance | 0 | 0 | 0 |
| Unallocated work | 0 | 0 | 0 |
| **Parent total** | **2160** | **3360** | **4730** |

Fixture reuse, port integration, and final combined verification are included within the applicable frontier estimates rather than placed in a separate allowance. T1b is verification-bearing but mandatory in the same release gate as T1a; it is not deferred test cleanup. The final combined gate must run all Structure commands and confirm the exclusions across the union of frontier changes.

The recursive frontier stops at high estimates below 1,000 lines for every leaf. Dependency ordering prevents an unsafe shipped state: T1a and T1b constitute one migration release gate, T2a and T2b constitute one atomic-create release gate, and the ticket cannot be considered complete until T3 and all T4 leaves pass together.

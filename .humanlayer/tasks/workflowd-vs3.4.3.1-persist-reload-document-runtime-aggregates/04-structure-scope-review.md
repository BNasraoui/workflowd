# Post-Structure Scope Review: Persist and Reload Document Runtime Aggregates

## Verdict
`SplitFeature`

## Estimate
estimatedChangedLines:
  low: 1565
  likely: 2300
  high: 3210
confidence: medium
decision: SplitFeature

| Surface | Low | Likely | High |
| --- | ---: | ---: | ---: |
| `src/store/migrations.ts` | 320 | 430 | 560 |
| `src/qrspi/stage-runtime.ts` | 180 | 260 | 350 |
| `src/qrspi/store.ts` | 300 | 430 | 600 |
| `test/store/migrations.test.ts` | 300 | 450 | 650 |
| New `test/qrspi/store.test.ts` | 450 | 700 | 1000 |
| `test/qrspi/workflow-start.test.ts` | 15 | 30 | 50 |
| Configuration and required documentation | 0 | 0 | 0 |
| **Total** | **1565** | **2300** | **3210** |

## Evidence
The baseline is exactly `40e65fa98829efbc50f94679b427fbfb04f1674f`; no production or test changes exist relative to that baseline.

The Structure covers the live child ticket’s main obligations and exclusions:

| Obligation | Structure coverage |
| --- | --- |
| Complete append-only shared runtime layout | Phase 1 creates the common, document, implementation, step, reference, diagnostic, and operation-ownership tables. |
| Guarded Generation cursor and format | Phase 1 adds all-or-none cursor columns and admits `stage_runtime_v1` while preserving existing rows. |
| Typed document aggregate round trip | Phase 2 adds document Schemas and atomic create/read methods. |
| Strict rejection before transition | Phase 3 covers SQL rejection and typed, non-mutating read diagnostics. |
| Inactivity and legacy preservation | Phases 1 and 3 prohibit runtime composition and add upgrade/inactivity regression proof. |
| Excluded behavior | No implementation API, allocation, replacement, claim, progression, bootstrap, quarantine, owner lifecycle, capacity, or legacy conversion is proposed. |

The migration is materially larger than an ordinary append-only table addition. The Structure requires approximately eleven strict table families, composite keys and foreign keys, variant ownership, partial uniqueness, ordered-child keys, hash and JSON checks, Generation cursor changes, and potentially a lossless `qrspi_generations` reconstruction. The current migration module is only 640 lines, with migrations `0009` and `0010` occupying roughly 65 lines combined (`src/store/migrations.ts:575-640`).

The store work is also substantial. The current `src/qrspi/store.ts` is 1,513 lines. Its existing trusted snapshot decoder occupies roughly 175 lines (`src/qrspi/store.ts:341-516`) for a much smaller row family. The proposed document decoder must coordinate a run, common revision, tagged payload, three pointers, ordered sources, ordered artifacts, two operation owners, strict JSON decoding, nested/relational identity comparison, and several canonical hashes.

The test matrix is the largest surface. The Structure requires:

- Schema-shape and migration-order inspection.
- Direct-SQL rejection across keys, tags, ownership, JSON, hashes, ordinals, and currentness.
- File-backed migration preservation from `0010`.
- Fixture construction for the complete prerequisite graph.
- Atomic round-trip and rollback proof.
- One-fault-at-a-time diagnostics for missing, malformed, duplicate, reordered, tag, role, identity, and hash failures.
- Non-mutation and inactivity regression proof.

The existing migration suite is already 833 lines and demonstrates that detailed testing of one comparatively small `qrspi_stage_definitions` table consumes about 280 lines (`test/store/migrations.test.ts:554-833`). The existing file-backed upgrade pattern also requires extensive setup (`test/qrspi/workflow-start.test.ts:1938-2060`).

Comparable repository changes support a range well above the admission trigger:

| Comparable change | Relevant size evidence |
| --- | --- |
| `ba0a4d9` trusted stage catalog and snapshots | 1,281 additions and 222 deletions across migration, store, domain, and tests. |
| `43a9fbb` exact typed QRSPI contracts | 4,813 additions and 185 deletions; broader than this ticket but demonstrates Schema and adversarial-test cost. |
| `1dffbc0` one durable input hash check | 124 additions across store and tests. |
| `a5a0afe` excess-property rejection | 96 additions and 4 deletions. |
| `f29ddd1` legacy Generation preservation | 97 additions and 12 deletions for a much narrower migration concern. |

The Structure allocates both accepted identity hooks explicitly. A bounded, non-null, globally unique `qrspi_stage_revisions.owner_crossing_key` is the stable seam for later handoff receipts, and the publication-role ownership row's unique WorkflowOperation foreign key is the publication-operation identity hook for later reconciliation. The shared-layout migration tests inspect both shapes and reject duplicate owner-crossing and physical-operation identities.

## Scope Signals
| Signal | Assessment |
| --- | --- |
| Independently useful acceptance groups | Strong. Shared schema installation, document persistence, and trusted corruption rejection each have distinct verification outcomes. |
| Multiple durable state machines or external-effect protocols | Against promotion. This child adds inert records and persistence only; it deliberately excludes transition and external-effect protocols. |
| Distinct trust boundaries | Strong. SQLite structural enforcement and Effect Schema/store semantic enforcement are separate boundaries with separate failure evidence. |
| Reusable framework plus consumers | Strong. The complete shared relational foundation is reusable by the implementation-aggregate sibling, while this child adds the first document consumer. |
| Separately releasable or revertible parts | Moderate. The inactive migration is independently deployable; document APIs remain inert. The trusted read boundary must be complete before consumers are composed. |
| One detailed Design covers the whole change | Against promotion. Accepted Design revision 3 resolves record ownership, enforcement, format, and exclusion decisions for all proposed work. |
| Safe intermediate states | Moderate. Schema-only deployment is safe because it creates no runtime rows or claim path. An incomplete public decoder should not be composed until adversarial verification is complete. |
| Estimate admission trigger | Strong. The 3,210-line high estimate materially exceeds 1,000 lines. |

## Decision Rationale
This is one coherent feature under one accepted Design, not a collection of independently designable product capabilities. Promotion would therefore overstate its conceptual breadth.

It is nevertheless too large for one reviewable implementation unit. The Structure itself identifies three dependency-ordered outcomes with distinct production and verification surfaces. The shared migration is independently useful to the blocked implementation sibling and is safe while inert. The document model and happy-path persistence can then be reviewed against that stable layout. The adversarial read boundary and inactivity proof form a final trust-focused task.

Keeping all three together would combine a large relational schema review, an Effect Schema/API review, transactional SQL review, file-backed upgrade proof, and an extensive corruption matrix in one diff. That would reduce review quality without avoiding a genuine intermediate-state hazard. Evidence is sufficient for an estimate, and the scope is too large for an unsplit review target.

## Proposed Decomposition
| Child outcome | Dependencies | Primary files | Low | Likely | High | Acceptance/control/risk coverage | Recursive status |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| Install the complete inactive shared runtime layout | None | `src/store/migrations.ts`, `test/store/migrations.test.ts` | 620 | 880 | 1210 | Complete-layout AC; SQL portions of contradictory-state AC; legacy preservation and inactivity AC. C1 SQL tagged shape and identity constraints; C5 format/ownership claim fence; C6 exclusion of owner lifecycles and neighboring policy. R1 malformed or mismatched durable-authority prevention; R5 append-only upgrade and restart exposure prevention. Both accepted identity hooks are allocated explicitly. | Requires its own scope review; not an implementation-ready leaf. |
| Define and atomically round-trip one exact document aggregate | Shared layout | `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`, new `test/qrspi/store.test.ts` | 580 | 850 | 1150 | Valid document aggregate scenario; exact guarded pointers, owner-crossing key, immutable artifacts, and WorkflowOperation ownership; strict input decode; rollback and deterministic reload. C1 Schema shape, identity, ordering, and hash enforcement; C5 ownership half of the claim fence; C6 exclusion of transition and neighboring behavior. R1 malformed or mismatched durable-authority prevention. | Requires its own scope review; not an implementation-ready leaf. |
| Complete contradictory-state diagnostics and inactivity proof | Document round trip | `src/qrspi/store.ts`, new `test/qrspi/store.test.ts`, `test/qrspi/workflow-start.test.ts` | 365 | 570 | 850 | Contradictory tagged-state scenario; exact missing/malformed/duplicate/reordered/tag/role/identity/hash diagnostics; non-mutation; unchanged WorkflowStart and no runtime claim path. C1 trusted shape/semantic decode completion and C6 inactivity/exclusion proof. R1 malformed or mismatched durable authority is rejected before use. | Requires its own scope review; not an implementation-ready leaf. |
| **Allocated total** |  |  | **1565** | **2300** | **3210** | All child acceptance criteria, scenarios, controls, risks, and exclusions allocated. |  |

Shared work is allocated to the first child rather than duplicated. Test fixture construction is allocated to the second child and extended by the third. There is no estimated overlap, separate integration allowance, or unallocated work. Child estimates therefore reconcile exactly to the parent range.

## Review Strategy
Not applicable for this verdict; each proposed child requires an independent recursive scope review before Plan or implementation.

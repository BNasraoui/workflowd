# Post-Structure Scope Review: Prove Shared Runtime SQL Invariants and Upgrade Preservation

## Verdict
`SplitFeature`

## Estimate
estimatedChangedLines:
  low: 840
  likely: 1300
  high: 1980
confidence: medium
decision: SplitFeature

| Surface | Planned outcome | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| `test/store/migrations.test.ts` | Shared complete runtime fixture, deterministic graph snapshot, rejection assertion, and foreign-key integrity helpers | 220 | 320 | 440 |
| `test/store/migrations.test.ts` | Phase 1 identity-spine, cursor, currentness, owner-crossing, tag, pointer, and ordinal rejection matrix | 160 | 240 | 340 |
| `test/store/migrations.test.ts` | Phase 2 tagged payload, reference, JSON/hash, nullable-shape, operation-role, and ownership rejection matrix | 300 | 470 | 680 |
| `test/store/migrations.test.ts` | Phase 3 file lifecycle, populated `0010` snapshots, fresh-layer upgrade, exact preservation, ledger, empty-runtime, and cleanup assertions | 160 | 240 | 340 |
| `src/store/migrations.ts` | Contingency for the smallest demonstrated `0011` constraint correction; no change is planned in the low case | 0 | 30 | 180 |
| Migrations, configuration, required documentation | No new surface is required by the accepted Structure | 0 | 0 | 0 |
| **Total** |  | **840** | **1300** | **1980** |

The estimate counts human-authored additions and substantive edits. It excludes generated files, lockfiles, formatter-only churn, tracker artifacts, and planning artifacts.

## Evidence

- The reviewed Structure is anchored to repository baseline `d5eaa71ecd50ed9d79558fb7608d059f70736cad`, which matches the current `HEAD`. Its three phases all carry implementation-bearing obligations in `test/store/migrations.test.ts`; each also permits a narrowly demonstrated correction in `src/store/migrations.ts`.
- The accepted ancestor Design hash independently resolves to `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`. Its decisions assign local shape, key, foreign-key, partial-index, and uniqueness invariants to SQLite, prohibit progression triggers, require append-only migration handling, preserve legacy facts without inferred runtime rows, and require real SQLite plus file-backed close/reopen proof.
- `test/store/migrations.test.ts` is already 2,041 lines. The existing migration-11 section defines a twelve-table inventory at lines 662-676, a limited in-memory Generation preservation smoke test at lines 887-937, and structural metadata tests through line 1,759. The Structure replaces the limited smoke proof and adds behavioral rejection evidence rather than merely extending a small isolated test.
- The valid graph must populate the existing workflow, ticket revision, workflow definition, stage definition, Generation, and physical WorkflowOperation parents plus all twelve runtime tables represented by `src/store/migrations.ts:644-1178`. The resulting fixture, deterministic all-table snapshot, and per-case rollback evidence are substantial shared test infrastructure even when invalid statements are table-driven.
- Phase 1 allocates unsupported format and lifecycle tags, nullable cursor contradiction, lower and upper ordinal bounds, duplicate current runs, duplicate owner-crossing keys, and three cross-run pointer families. Phase 2 adds both tagged variants, five reference/diagnostic families, two tagged operation-owner families, JSON root and non-empty-array guards, nullable pairs and triads, all hash families, operation role/kind agreement, duplicate roles, and physical-operation uniqueness. These are materially more cases than the current DDL substring assertions.
- The repository's closest completed migration-layout changes are useful only as scale anchors, not as the known size of this ticket. Commit `09b236f` changed 206 production and 658 test lines; follow-up commit `879d279` changed 342 production and 621 net test lines. They show that complete strict-schema fixture and assertion work in this module routinely occupies several hundred lines per coherent outcome.
- The repository's existing file-backed pattern at `test/qrspi/workflow-start.test.ts:1938-2060` uses separate `SqliteClient.layer({ filename })` lifetimes and explicit historical setup. The new proof is wider: it must snapshot every shipped Generation and WorkflowOperation column across diverse rows, verify migration-ledger advancement, check both new cursor columns, query all twelve runtime tables, check foreign keys, and guarantee temporary-directory cleanup.
- No production correction is presently identified. The medium confidence reflects that direct execution may reveal an allocated invariant accepted by `0011`; the high estimate reserves bounded production and corresponding test work without assuming a defect or weakening any acceptance obligation.
- No production Provenance graph root, authenticated gate authority, or production Structure authority was needed or inferred for this advisory size review. The review relies on the ticket snapshot, the locally hash-verified accepted Design, the reviewed Structure, and the repository baseline.

## Scope Signals

| Signal | Evidence |
| --- | --- |
| Independently useful acceptance groups | Strong. Identity-spine rejection, tagged/reference/ownership rejection, and exact `0010` file upgrade preservation each produce executable evidence for a distinct allocated risk group. |
| Multiple durable state machines or external-effect protocols | Against promotion. This ticket adds no state machine or external-effect protocol; it verifies one inactive relational layout. |
| Distinct trust boundaries | Moderate. Phases 1 and 2 exercise the direct-SQL constraint boundary, while Phase 3 exercises the persisted-file migration boundary. Both remain under the same accepted storage Design. |
| Reusable framework plus consumers | Moderate. The complete valid-graph and snapshot harness is reusable by both SQL rejection groups, but it is test infrastructure rather than a separately prioritized product framework. |
| Separately releasable or revertible parts | Implementation is safely additive and separately revertible, but the migration release gate remains closed until all children pass. Splitting does not authorize partial release. |
| One detailed Design covers the whole change | Strongly against epic promotion. One accepted Design fixes the SQL/application invariant allocation, append-only upgrade rule, zero-inference rule, and testing boundary for all three outcomes. |
| Admission trigger | The 1,980-line high estimate exceeds 1,000 lines. The trigger requires an explicit decision, and the independent acceptance groups provide non-artificial seams. |

## Decision Rationale

`SplitFeature` fits because this is one coherent migration-verification feature under one accepted Design, but its complete production-quality proof is not one reviewable diff. The likely estimate is 1,300 changed lines and the high estimate is 1,980, concentrated in an already large test module and spanning two trust-boundary styles.

`FeatureFit` understates the fixture and matrix breadth and would combine three independently inspectable proof obligations above the admission trigger. `PromoteToEpic` is too broad because the outcomes are not independently designable or prioritizable product features and none may independently satisfy the release gate. `KeepLarge` is unnecessary: additive tests and narrowly owned fixture evolution create no unsafe persisted intermediate state, compatibility duplication, or artificial domain boundary. `NeedsResearch` is unwarranted because the accepted Design, complete Structure, current schema and tests, prior migration diffs, and file-backed repository pattern support a reconciled medium-confidence estimate; uncertainty about whether a test discovers a schema defect is explicitly represented in the range.

## Proposed Decomposition

| Child | Vertical outcome | Dependencies | Primary files | Low | Likely | High | Exact coverage |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| T1: Prove runtime identity-spine SQL rejection | Build the complete valid runtime graph and deterministic unchanged-graph harness, then prove Generation cursor, StageRun currentness, common revision identity, format/state/kind tags, owner-crossing identity, same-run pointers, and identity ordinals reject contradictions. | Completed layout child `workflowd-vs3.4.3.1.1` | `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` | 380 | 575 | 860 | Acceptance criterion 1 for identity-spine cases; unchanged valid graph and `PRAGMA foreign_key_check`; same-Generation cursor, one-current-run, owner-crossing uniqueness, same-run pointers, append-only history, format/cursor guards, and any correction exposed by these cases. Owns the shared fixture and snapshot harness. |
| T2: Prove tagged payload, reference, and operation-ownership SQL rejection | Extend T1's fixture through every tagged child and prove wrong variants, malformed JSON/hash shapes, nullable pairs/triads, reference and diagnostic ordinals, owner-role/kind disagreement, duplicate roles, and cross-owner physical-operation reuse are rejected. | T1 | `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` | 300 | 480 | 740 | Remainder of acceptance criterion 1; SQL-local portion of A3 for tagged-table ownership, sibling schema completeness, immutable-reference shapes, diagnostics, operation hooks, role uniqueness, physical-operation uniqueness, and any correction exposed by these cases. Every case retains unchanged-graph and foreign-key proof. |
| T3: Prove exact file-backed `0010` upgrade preservation | Populate a real file database through `0010`, close it, migrate a fresh layer, and prove complete Generation and WorkflowOperation equality, null runtime cursors, one ledger advance, no inferred rows in all twelve runtime tables, foreign-key integrity, and cleanup. | Completed layout child `workflowd-vs3.4.3.1.1`; independent of T1 and T2 implementation | `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` | 160 | 245 | 380 | Acceptance criteria 2 and 3 and the preservation portion of criterion 4/A1; append-only `0011`, every shipped value and identity, retry/currentness/nullable fields, format preservation, zero legacy conversion, zero runtime authority, FK/index fidelity, and any correction exposed by the upgrade proof. |
| **Total** |  |  |  | **840** | **1300** | **1980** | Complete parent allocation |

Allocation accounting:

- T1 owns all shared fixture and graph-snapshot work. T2 consumes and extends that committed fixture; no fixture lines are counted twice.
- The production contingency is allocated to the child that demonstrates the defect: T1 includes `0/15/80`, T2 includes `0/10/60`, and T3 includes `0/5/40` within the displayed child estimates.
- Verification and integration assertions are included in each child's estimate. There is no separate shared, overlapping, integration, documentation, configuration, migration-file, or unallocated allowance.
- T1, T2, and T3 reconcile exactly to the parent range: `380 + 300 + 160 = 840`, `575 + 480 + 245 = 1300`, and `860 + 740 + 380 = 1980`.
- Every proposed child is implementation-bearing and requires its own independent post-Structure scope review. None is an implementation-ready leaf at this review.
- The parent release gate remains atomic: completion or release must not be claimed until all three outcomes pass together. Tests, schema corrections, migration preservation, recovery cleanup, and integration proof are not deferred cleanup.

## Review Strategy

Review T1 first because it establishes the shared valid-graph and unchanged-state harness. T2 should be reviewed as a bounded extension of that harness, with a matrix-to-constraint reconciliation that distinguishes SQL-local guarantees from semantic guarantees reserved for typed writes and strict reads. T3 can proceed independently against the completed layout baseline and should be reviewed as a file-lifecycle and exact-row-preservation proof. After all recursive reviews and implementations complete, run `bun test test/store/migrations.test.ts`, `bun run check`, and `git diff --check`, then perform one parent-level acceptance reconciliation before treating the migration release gate as satisfied.

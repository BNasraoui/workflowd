# Post-Structure Scope Review: Complete Tagged Graph and Reject Payload Contradictions

## Verdict
`FeatureFit`

## Estimate
estimatedChangedLines:
  low: 475
  likely: 670
  high: 960
confidence: medium
decision: FeatureFit

| Surface | Planned outcome | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| `test/store/migrations.test.ts` fixture and positive proof | Complete the tagged graph, seed all sibling-consumable rows, update the eighteen-table inventory, and prove enabled and clean foreign keys | 150 | 210 | 280 |
| `test/store/migrations.test.ts` variant boundary | Fixed document/implementation tags and document/implementation cross-variant payload or step rejection | 45 | 65 | 90 |
| `test/store/migrations.test.ts` relational identity boundary | Wrong workflow, Generation, stage, and revision coordinates for both payload variants and implementation steps | 80 | 115 | 165 |
| `test/store/migrations.test.ts` local payload boundary | Source-set, JSON root, SHA-256, nullable-pair, step-triad, `final`, and position-bound rejection cases | 180 | 250 | 350 |
| `test/store/migrations.test.ts` reconciliation and contingency assertions | Named-case/acceptance reconciliation plus exact DDL assertions only if a demonstrated migration correction is needed | 20 | 30 | 45 |
| `src/store/migrations.ts` | Contingency-only correction to an existing `0011_qrspi_stage_runtime_layout` check or composite foreign key | 0 | 0 | 30 |
| Migrations, configuration, and required documentation outside the files above | No new migration, configuration, generated artifact, or required documentation is identified | 0 | 0 | 0 |
| **Total** |  | **475** | **670** | **960** |

The totals count human-authored additions and substantive edits. They exclude generated files, lockfiles, formatter-only churn, and this scope-review artifact. The 960-line high estimate remains below the 1,000-line admission trigger, although it is close enough that material expansion should cause a new scope review rather than compressed testing.

## Evidence

- The Structure allocates all three phases primarily to `test/store/migrations.test.ts`; `src/store/migrations.ts` is explicitly no-change unless a named direct-SQL statement demonstrates a missing local constraint. It identifies no migration, configuration, or documentation deliverable.
- The current baseline is Structure SHA `10c600c0600280c622d826a0b8bbec9bdb53d1ad`. `test/store/migrations.test.ts` is 2,794 lines and already contains the complete reusable mechanics: `runtimeGraphOrder` over eighteen tables at lines 681-703, `readRuntimeGraph` at lines 705-716, `runtimeFixture` at lines 718-733, `seedValidRuntimeIdentitySpine` at lines 735-935, `expectIdentitySpineRejection` at lines 937-949, and data-driven fresh-database tests at lines 984-1202.
- The positive fixture currently stops exactly at this ticket's frontier: two physical operations and zero implementation steps, immutable references, checkpoints, diagnostics, common owners, or tagged owners are asserted at lines 962-980. The ticket therefore extends an existing fixture rather than creating a second harness.
- Existing migration DDL already expresses the allocated SQL-local constraints: source-set array and lowercase SHA-256 checks at `src/store/migrations.ts:740-748`; document payload object/hash/pair constraints at lines 837-863; implementation payload constraints at lines 866-895; and implementation-step object/hash/triad/position constraints at lines 898-929. Existing composite foreign keys provide the tagged parent boundaries. This makes production code a bounded contingency rather than likely work.
- Comparable baseline changes provide repository-local sizing evidence. Commit `93069f5` added 439 lines to `test/store/migrations.test.ts` for the initial identity fixture and local-guard matrix; commit `65c6bf4` added 84 lines for its relational-guard matrix. The present ticket reuses those helpers but adds a deeper fixture and a broader local-shape matrix, supporting a likely estimate above those two changes combined without requiring a second module.
- The accepted Design places local shape, keys, foreign keys, and bounds in SQLite while reserving canonical hashes and semantic identity for Schema/store behavior (`03-design-discussion-stage-runtime-state.md:168-172`). The ticket and Structure preserve that division and expressly exclude typed decoding, canonical recomputation, transitions, triggers, runtime behavior, upgrade preservation, and legacy conversion.
- Missing evidence: there is no completed repository change with this exact tagged fixture plus the full payload/triad matrix, and no invalid statement has yet been executed against the baseline. Those uncertainties account for the medium confidence and the production/test contingency in the high estimate; they do not prevent a credible range because the target DDL, test harness, and adjacent comparable changes are present.

## Scope Signals

| Signal | Evidence | Effect on decision |
| --- | --- | --- |
| Independently useful acceptance groups | Fixture completion, variant rejection, parent-identity rejection, and local-shape rejection are separately inspectable, but the ticket requires all of them as one unchanged-complete-graph proof. The ticket says the child is not separately releasable. | Against splitting |
| Multiple durable state machines or external-effect protocols | None are introduced. The work executes direct SQL against existing inactive migration tables and observes rollback/equality and foreign-key integrity. | Against splitting or promotion |
| Distinct trust boundaries | All cases test one SQLite local-integrity boundary. Schema decoding, canonical semantics, runtime transitions, and external effects are excluded. | Against splitting or promotion |
| Reusable framework plus consumers | The completed fixture is intentionally consumed by two sibling Beads, but this ticket owns the one fixture extension and its own payload/tag cases. Extracting fixture construction into a separate child would leave this outcome dependent on a partial test-only frontier and duplicate integration review. | Weak split signal, outweighed by shared atomic fixture |
| Separately releasable or revertible parts | No allocated phase is separately releasable; passing this child does not release the parent gate, and its own acceptance requires the complete matrix. | Against splitting or promotion |
| One detailed Design covers the change | The accepted D3 Design consistently assigns local relational and shape enforcement to SQLite and defines the tagged records and exclusions used by every phase. No phase needs an independent design decision. | Against promotion |
| Review size | Likely 670 changed lines and high 960, concentrated in one existing test module. The high estimate approaches but does not cross the admission trigger. | Supports FeatureFit with staged review |

## Decision Rationale

`FeatureFit` fits better than the other verdicts because this is one bounded SQL-local verification outcome built around one complete fixture and one rejection contract. The three Structure phases are useful review order, but not safe product boundaries: Phase 2 and Phase 3 require the complete Phase 1 graph, and the ticket's exact-before/after and foreign-key guarantees must be reconciled across the full named matrix.

`SplitFeature` would turn test organization into tracker boundaries without producing independently releasable behavior, and would force repeated integration accounting around the same mutable fixture. `PromoteToEpic` is not supported because there are no independently designable or prioritizable features inside the accepted ticket. `KeepLarge` is unnecessary because the high estimate does not cross the admission trigger and the likely change remains reviewable. `NeedsResearch` is unnecessary because the existing DDL, fixture, harness, accepted Design, and comparable commits support a reconciled estimate; the remaining uncertainty is normal implementation variance rather than missing authority or architecture.

## Proposed Decomposition

Not applicable for `FeatureFit`. The Structure's three phases should remain review checkpoints within this one feature, not implementation-bearing child tickets.

## Review Strategy

1. Review the fixture extension first. Reconcile every inserted row with all eighteen `runtimeGraphOrder` tables, verify that reference, diagnostic, and ownership rows are valid fixture-only data, and run the positive seed proof with `PRAGMA foreign_keys = 1` and an empty `PRAGMA foreign_key_check`.
2. Review the fixed-tag and cross-variant cases next. Require one fresh database and one `expectIdentitySpineRejection` call per named case, with no sibling-owned contradiction coverage.
3. Review the wrong-parent matrix by variant and coordinate. Confirm every statement is otherwise valid and changes only workflow, Generation, stage, revision, or the applicable step identity needed to isolate the intended composite foreign key.
4. Review source-set, payload, pair, triad, `final`, and bound cases as a named matrix. Preserve all-null and complete implementation-step triads as positive controls and do not infer canonical hash or collection semantics from SQL shape checks.
5. Reconcile every ticket acceptance item and exclusion against executable names before final verification. Run `bun test test/store/migrations.test.ts`, `bun run check`, and `git diff --check` as required by the Structure.
6. If any invalid statement is accepted, keep the correction to the demonstrated `0011` check or composite foreign key and add its exact DDL assertion. Rerun this scope review if production work broadens beyond that contingency, a new surface appears, or the implementation is forecast to exceed 960 changed lines. Do not reduce matrix coverage to stay below the estimate.

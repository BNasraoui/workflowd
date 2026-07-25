# Post-Structure Scope Review: Prove Exact File-Backed 0010 Upgrade Preservation

## Verdict
`FeatureFit`

## Estimate
estimatedChangedLines:
  low: 225
  likely: 315
  high: 475
confidence: medium
decision: FeatureFit

| Surface | Planned files | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| Production code | None planned | 0 | 0 | 0 |
| Tests | `test/store/migrations.test.ts` | 225 | 310 | 435 |
| Migration correction contingency | `src/store/migrations.ts` | 0 | 5 | 40 |
| Configuration | None | 0 | 0 | 0 |
| Required documentation | None | 0 | 0 | 0 |
| **Total** |  | **225** | **315** | **475** |

The test subtotal includes approximately 20/30/45 lines for imports and local file-lifecycle scaffolding, 55/75/105 for parent and Generation fixtures, 80/105/145 for diverse WorkflowOperation history, and 70/100/140 for ordered snapshots, fresh-layer migration, idempotence, empty-table, foreign-key, and retained-index assertions. These components reconcile to the 225/310/435 test range. The separate 0/5/40 migration contingency covers only the smallest demonstrated correction to append-only `0011`; it is not assumed to be necessary.

## Evidence
- The Structure has one implementation-bearing phase and names one primary file, `test/store/migrations.test.ts`, plus a conditional `src/store/migrations.ts` correction. Its obligations cover a real temporary file, two independently constructed SQLite layer lifetimes, complete ordered snapshots, migration-ledger idempotence, null cursors, twelve empty runtime tables, foreign-key integrity, retained indexes, and failure-safe cleanup.
- The current preservation test at `test/store/migrations.test.ts:887-937` is about 51 lines and already provides the required through-`0010` parent fixture, one Generation insert, migration invocation, and basic no-inference assertions. The change replaces and substantially expands that block rather than introducing a new test subsystem.
- `test/store/migrations.test.ts:663-676` already defines the canonical twelve-table `runtimeTables` inventory. `test/store/migrations.test.ts:781-885`, `test/store/migrations.test.ts:1685-1724`, and `test/store/migrations.test.ts:1726-1758` already encode the Generation and WorkflowOperation index expectations and zero-runtime-fact patterns that the new test can reuse or retain.
- `src/store/migrations.ts:634-642` already exports `runStoreMigrationsThrough0010`, and `src/store/migrations.ts:1180-1185` registers append-only `0011`. No new migration runner, production service, API, or configuration seam is required.
- The shipped row widths are material: `qrspi_generations` has fifteen pre-`0011` columns at `src/store/migrations.ts:502-526` plus its format migration at `src/store/migrations.ts:610-617`; `workflow_operations` has the identity, retry, lease, effect, output, failure, JSON, hash, and timestamp fields at `src/store/migrations.ts:423-483`. Diverse valid rows therefore require a sizeable but bounded SQL fixture.
- The repository already demonstrates fresh file-backed layer construction in `test/qrspi/workflow-start.test.ts:1938-2060` and local `mkdtemp`/`rm` lifecycle handling in `test/store/reconciliation.test.ts:425-428`. The review does not allocate work for a reusable harness.
- A comparable focused migration-and-test change, commit `0015d8a`, changed 86 test lines and 10 migration lines for a narrower preservation case. This ticket adds substantially broader fixture diversity, complete two-table snapshots, close/reopen proof, ledger rerun, twelve table counts, and index/FK checks, supporting the larger test range.
- The accepted Design requires append-only migrations, byte-for-byte preservation of legacy facts, zero inferred runtime authority, and file-backed prior-frontier reopening (`03-design-discussion-stage-runtime-state.md:204-218` and `:345-359`). The Structure stays within those controls and the ticket exclusions.
- Whether the proof exposes a real `0011` defect is not knowable before execution. That missing fact lowers confidence from high but does not prevent a credible bounded estimate because the Structure explicitly limits any production response to the existing migration and the smallest demonstrated correction.
- This review relies on the local accepted Design, Structure, ticket snapshot, and repository baseline. It does not assert an authenticated production gate, production Provenance publication, or a Provenance graph snapshot.

## Scope Signals
- **Independently useful acceptance groups:** Exact row preservation and zero-runtime-authority postconditions can be described separately, but both depend on the same populated file, migration boundary, and before/after snapshots. Splitting them would duplicate fixture and lifecycle work and weaken the single upgrade proof.
- **Durable state machines or external-effect protocols:** None are introduced. The only protocol is a bounded SQLite historical-layer close followed by a fresh current-layer migration and readback. Temporary-file cleanup is resource hygiene, not a second durable state machine.
- **Distinct trust boundaries:** There is one storage boundary across two SQLite layer lifetimes over the same file. No network, credential, production gate, or external authority boundary is added.
- **Reusable framework plus consumers:** No framework is required. Existing migrators, `SqliteClient.layer`, metadata helpers, runtime-table inventory, and index expectations are sufficient for one focused integration test.
- **Separately releasable or revertible parts:** The test and a demonstrated migration correction would need to land atomically; a correction without its proof or a partial proof without all preservation postconditions is not an independently releasable outcome. The parent release gate also remains atomic with its sibling SQL-rejection outcomes, but this child does not implement those siblings.
- **One detailed Design:** The accepted ancestor Design directly fixes the prior migration frontier, append-only rule, no-conversion boundary, inactivity requirement, and file-backed verification pattern for this complete change.
- **Admission trigger:** The high estimate is 475 changed lines, below the 1,000-line trigger. No size-based decomposition decision is required.

## Decision Rationale
`FeatureFit` best matches one conceptually narrow, production-quality upgrade-preservation proof. All ticket obligations fit in one test file around one historical fixture and one fresh migration lifecycle, with a tightly bounded conditional edit to the existing `0011` migration. The estimated high case remains reviewable, and the Structure assigns every acceptance criterion, control, and retained risk.

`SplitFeature` would create artificial seams between fixture construction, exact snapshots, migration execution, and postconditions that must share one database lifecycle to constitute evidence. `PromoteToEpic` is inappropriate because there are no independently designable or prioritizable features. `KeepLarge` is unnecessary because the estimate does not cross the admission trigger and does not need an exceptional large-change strategy. `NeedsResearch` is unwarranted: the only uncertainty is whether a bounded production correction is needed, and the estimate explicitly accounts for it.

## Review Strategy
1. Review the historical fixture first: verify valid required parent rows, multiple Generations across both shipped formats and currentness/state combinations, and WorkflowOperations covering retry lineage, leases, nullable/populated effect and output fields, terminal metadata, JSON, hashes, and timestamps without introducing runtime rows.
2. Review the lifecycle boundary: require a real temporary file, complete closure of the through-`0010` layer, a separately constructed current layer over the same filename, and `try/finally` cleanup that also runs on setup, migration, query, or assertion failure.
3. Review preservation as one evidence block: deterministic complete `SELECT *` ordering, exact pre-existing Generation values after excluding only the two newly added cursor columns, direct complete WorkflowOperation equality, and unchanged identities and `generation_format` values.
4. Review postconditions together: exact ten-row ledger prefix, one `0011` row after migration and rerun, null runtime cursors, zero rows in all twelve canonical runtime tables, empty `PRAGMA foreign_key_check`, and retained Generation and WorkflowOperation index assertions.
5. If the proof demonstrates a production defect, review the failing assertion before the correction and then review only the minimal append-only `0011` change. Reject edits to `0001` through `0010`, inferred conversion, weakened constraints, runtime APIs, or unrelated SQL rejection coverage.
6. Run `bun test test/store/migrations.test.ts`, `bun run check`, and `git diff --check`, then inspect the final diff for the two-layer lifetime, complete snapshots, cleanup, exclusions, and absence of deferred migration, recovery, security, or integration work.

# Post-Structure Scope Review: Correct and Prove Diagnostic Pair Completeness

## Verdict
`FeatureFit`

## Estimate
estimatedChangedLines:
  low: 205
  likely: 291
  high: 400
confidence: high
decision: FeatureFit

| Surface | Planned outcome | Low | Likely | High |
|---|---|---:|---:|---:|
| `src/store/migrations.ts` | Add the expected and actual nullable-pair equality checks to migration `0011_qrspi_stage_runtime_layout` | 6 | 8 | 12 |
| `test/store/migrations.test.ts` | Define and execute 25 fresh-graph rejection cases for parent identity, literals and bounds, JSON, hashes, and one-sided pairs | 150 | 205 | 275 |
| `test/store/migrations.test.ts` | Prove the two allowed asymmetric absence shapes and post-write foreign-key integrity | 35 | 55 | 75 |
| `test/store/migrations.test.ts` | Lock both checks in the exact tagged-layout metadata inventory | 2 | 5 | 10 |
| `test/store/migrations.test.ts` | Reconcile the named rejection and positive-control inventory to the allocated parent criteria and non-release boundary | 12 | 18 | 28 |
| Migrations outside `src/store/migrations.ts` | None: migration `0011` is defined in the production migration source above | 0 | 0 | 0 |
| Configuration | None | 0 | 0 | 0 |
| Required documentation | None; the ticket requires executable reconciliation rather than a documentation change | 0 | 0 | 0 |
| **Total** |  | **205** | **291** | **400** |

The range counts human-authored additions and substantive edits. It excludes generated files, lockfiles, vendored files, formatting-only churn, and the review artifact itself.

## Evidence

- The accepted Structure is content-addressed at SHA-256 `870954342a9bfdbb25d489d9f6884c39539ddbe197de5d89efc7d162e0195dc7` and fixes one phase, two changed files, 25 rejection cases, two positive controls, metadata assertions, and one coverage reconciliation (`01-structure-outline-diagnostic-pair-completeness.md:28-63`).
- Repository `HEAD` is the Structure baseline `2ef27d2d8d11a585e7118776c2b93a679d0bdc9b`. The relevant files currently contain 1,185 and 4,248 lines respectively, so the estimate is against the accepted source state rather than an inferred future implementation.
- `src/store/migrations.ts:1052-1095` already defines `qrspi_stage_revision_diagnostics` with nullable object-JSON checks, lowercase 64-character hash checks, bounded literals, a composite primary key, and the composite StageRevision foreign key. The production delta is therefore only the two explicitly authorized pair checks; it does not require a new table, migration runner, trigger, or application service.
- `test/store/migrations.test.ts:800-1127` already seeds the complete eighteen-table tagged runtime graph, including a valid complete diagnostic. `test/store/migrations.test.ts:1129-1141` already provides the rejection helper that compares the complete graph before and after rejection and verifies enabled and clean foreign keys. Fixture and harness construction are not part of this estimate.
- Existing test organization supplies the intended compact pattern: descriptor arrays followed by one fresh-database test loop (`test/store/migrations.test.ts:1248-1258`, `1428-1438`). The 25 cases can reuse that pattern without 25 bespoke harnesses.
- Exact metadata infrastructure already inventories diagnostic columns, foreign keys, strict DDL snippets, reason literals, and indexes (`test/store/migrations.test.ts:3400-3826`, `3856-3858`). Adding the two snippets is a small edit rather than a new metadata framework.
- Existing reconciliation style is a small named count assertion (`test/store/migrations.test.ts:2424-2436`). The proposed diagnostic reconciliation can follow that established form.
- Comparable repository changes bound the estimate. Commit `2ad347f` added 180 test lines for twelve tagged parent-identity cases and their loop. Commit `f1ea901` added 333 test lines for a broader tagged payload matrix including JSON, hash, pair, triad, position, and shared execution patterns. Commit `eb73d80` changed 260 lines to build and prove the complete graph fixture. This ticket reuses that fixture and helper, has 25 compact diagnostic mutations plus two success paths, and therefore reasonably falls between roughly 200 and 400 changed lines.
- The accepted Design content hash locally verifies as `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`. It assigns local SQL shape to strict checks and foreign keys, semantic and cross-row behavior to decoded store transactions, and explicitly avoids progression triggers (`03-design-discussion-stage-runtime-state.md:83-87`, `168-172`). The Structure preserves that control boundary.
- The referenced graph export exists and locally verifies as SHA-256 `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`. Its declared artifact kind is `local_content_addressed_graph_export` and its authority limit is `Local QRISPI compatibility snapshot; not production Provenance publication`. This review relies only on that stated local compatibility evidence and makes no production Provenance, authentication, graph-root, or gate-authority claim.

## Scope Signals

| Signal | Evidence | Effect on decision |
|---|---|---|
| Independently useful acceptance groups | Parent identity, literal/bound, JSON/hash, pair rejection, positive absence, metadata, and reconciliation are distinguishable test groups, but none is a complete useful outcome without the pair correction and its full proof. | Against splitting |
| Multiple durable state machines or external-effect protocols | None. The change exercises one existing diagnostic row under SQLite constraints and performs no external effect, lease, retry, transition, or recovery protocol. | Against splitting or promotion |
| Distinct trust boundaries | None. All behavior remains inside the existing direct-SQL migration boundary; application semantic validation, typed diagnostics, quarantine, and parent release are explicitly excluded. | Against splitting or promotion |
| Reusable framework plus consumers | The complete graph fixture, rejection helper, metadata reader, and migration framework already exist and are dependencies, not new framework work in this ticket. | Against splitting |
| Separately releasable or revertible parts | The ticket and Structure require the two DDL checks, all behavioral evidence, positive controls, and metadata lock to land atomically. Tests without the checks fail; checks without complete proof do not satisfy the allocated outcome. | Against splitting |
| Independently designable or prioritizable features | No. Every obligation is the diagnostic subset recursively allocated from the parent. Artifact references, checkpoints, operation ownership, typed quarantine, canonical semantics, and parent release belong elsewhere. | Against promotion |
| One detailed Design covers the whole change | Yes. The accepted ancestor Design defines the SQL-local versus semantic enforcement seam, diagnostic role, trigger prohibition, testing boundary, and ownership exclusions for the entire slice. | Supports FeatureFit |
| Admission trigger | The high estimate is 400 changed lines, well below the 1,000-line admission trigger. | Supports FeatureFit |

## Decision Rationale

`FeatureFit` fits better than the other verdicts because this is one narrow correction with one direct-SQL proof matrix, one accepted control boundary, two primary files, no new framework, and a high estimate of 400 changed lines. The complete production-quality outcome is reviewable as a single diff, and keeping migration and proof together makes the review safer.

`SplitFeature` would create artificial horizontal tasks such as DDL, negative tests, positive tests, or metadata. Those tasks are not independently useful or safely verifiable against the acceptance criteria: the new checks require behavioral and metadata proof, while the proof requires the checks. `PromoteToEpic` is not justified because there are no independently designable or prioritizable features inside the allocated diagnostic outcome. `KeepLarge` is unnecessary because the estimate does not approach the admission trigger and the existing abstractions keep the implementation compact. `NeedsResearch` is not justified because the accepted Design and Structure, exact baseline, current DDL, inherited fixture and helper, metadata framework, and comparable commits provide enough evidence for a high-confidence range.

Every parent obligation is allocated in the estimate: acceptance criteria 1-3 map to the 25 rejection cases; criterion 4 maps to the migration checks plus one-sided and absence behavior; criterion 5 maps to positive controls and exact metadata; criterion 6 maps to the inherited rejection helper used by every invalid statement; criterion 7 maps to named reconciliation and explicit claim boundaries; criterion 8 remains the non-release condition. Exclusions require no implementation work but must be checked during review.

## Review Strategy

1. Review the production hunk first and require exactly the two local equality checks adjacent to the existing JSON/hash checks. Reject any trigger, non-null requirement, expected-versus-actual comparison, canonical semantic, cross-row rule, or other migration change.
2. Review the 25 descriptors as five reconciled groups: 4 parent identities, 7 literals/bounds, 4 JSON shapes, 6 hash shapes, and 4 one-sided pairs. Confirm each descriptor changes only its named coordinate or field while all other diagnostic values remain valid.
3. Confirm the shared execution loop gives every invalid descriptor a fresh `runWithDatabase`, calls `seedValidRuntimeIdentitySpine`, and delegates rejection, exact eighteen-table graph equality, foreign-key enablement, and `foreign_key_check` cleanliness to `expectIdentitySpineRejection` without weakening that helper.
4. Review the two positive controls independently. Each must begin from a fresh complete graph, clear exactly one complete pair, retain the other complete pair, read back the exact four nullable values, and verify enabled and clean foreign keys.
5. Compare the metadata change with the production DDL. Require both equality snippets while preserving the existing diagnostic column order, strict status, composite foreign key, reason vocabulary, JSON/hash snippets, primary-key-only diagnostic index inventory, and no-trigger assertion.
6. Reconcile executable names and counts to 25 rejection cases and 2 positive controls, then verify the claim text covers only immediate-parent criteria 3 and 4 and diagnostic portions of 5 and 6. Treat criterion 7 and parent release as explicit non-claims, not SQL behavior.
7. Run the Structure validations together: `bun test test/store/migrations.test.ts`, `bun run typecheck`, `bun run effect:check`, `bun run check`, and `git diff --check`. Review the final migration and test diff atomically after those checks pass.

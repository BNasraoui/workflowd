# Post-Structure Scope Review: Prove Runtime Identity-Spine SQL Rejection

## Verdict
`FeatureFit`

## Estimate
estimatedChangedLines:
  low: 440
  likely: 640
  high: 930
confidence: medium
decision: FeatureFit

| Surface | Allocation | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| `test/store/migrations.test.ts` | Deterministic constants and complete fresh-SQLite parent/runtime fixture | 180 | 250 | 330 |
| `test/store/migrations.test.ts` | Stable full-graph snapshot and shared reject/unchanged/FK assertion | 70 | 100 | 140 |
| `test/store/migrations.test.ts` | Format, tag, currentness-value, run/revision/cursor/pointer ordinal cases | 90 | 140 | 180 |
| `test/store/migrations.test.ts` | Half-cursor, cross-Generation cursor, duplicate-current, duplicate-owner-key, and three cross-run pointer cases | 100 | 150 | 200 |
| `src/store/migrations.ts` | Contingency for the smallest demonstrated `0011` constraint or index correction | 0 | 0 | 80 |
| Migrations, configuration, required documentation | No separately planned files; `0011` is corrected in place only if a test exposes a defect | 0 | 0 | 0 |
| **Total** |  | **440** | **640** | **930** |

The estimate counts additions and substantive edits. It excludes generated files, lockfiles, vendored code, formatter-only churn, and this review artifact.

## Evidence

- The ticket requires one reusable real-SQLite fixture, one deterministic unchanged-graph harness, the complete allocated identity-spine rejection matrix, and `PRAGMA foreign_key_check`; it excludes tagged payload/reference/operation ownership cases, file-backed upgrade proof, typed stores, runtime lifecycle behavior, and neighboring capabilities (`ticket.md:14-29`, `ticket.md:35-58`).
- The accepted Design puts local shapes, literals, keys, composite foreign keys, uniqueness, and one-current-row rules in strict SQLite, while reserving semantic and coordinated progression for Schemas and store transactions. It explicitly rejects SQL triggers for progression (`03-design-discussion-stage-runtime-state.md:168-172`). The Structure preserves that boundary and expressly excludes monotonic allocation, lifecycle-pointer agreement, cursor/currentness agreement, and general update/delete prohibition (`01-structure-outline-runtime-identity-spine.md:61-69`).
- Phase 1 has three implementation-bearing test outcomes: seed a complete graph, snapshot every fixture-owned parent/runtime table in stable order, and execute the local literal/ordinal matrix (`01-structure-outline-runtime-identity-spine.md:34-43`). Phase 2 adds four relational groups: cursor shape and Generation identity, one-current-run, owner-crossing uniqueness, and pending/published/accepted same-run pointers (`01-structure-outline-runtime-identity-spine.md:59-69`). Every phase and parent acceptance obligation appears in the estimate table.
- The present test suite already centralizes migration-11 structural and file-backed coverage in `test/store/migrations.test.ts`, a 2,271-line file. Its migration-11 suite begins at line 665, inventories all 12 runtime tables at lines 666-679, and currently ends at line 1990 without the requested reusable valid-graph rejection fixture or matrix. The existing upgrade test demonstrates the repository's real-SQLite, foreign-key, deterministic-read, and exact-equality style at lines 918-1167.
- A complete snapshot is materially larger than a single-table assertion: the Structure names workflow, ticket revision, workflow definition, stage definition, Generation, WorkflowOperation, and every runtime table (`01-structure-outline-runtime-identity-spine.md:19-23`, `01-structure-outline-runtime-identity-spine.md:40-42`). Stable reads therefore cover the parent spine plus the 12 runtime tables already enumerated by the suite.
- Current production evidence supports a contingency-only estimate. `src/store/migrations.ts:658-758` contains StageRun and common StageRevision ordinal/literal checks, global `owner_crossing_key` uniqueness, and the same-run revision identity. Lines 761-803 contain the Generation format, paired cursor check, cursor ordinal bound, and same-Generation composite foreign key. Lines 832-835 contain the partial one-current-run index. The StageRun pending, published, and accepted composite foreign keys are at lines 708-722.
- Comparable repository changes bound the estimate. Commit `ca48953` changed 328 lines in `test/store/migrations.test.ts` for exact file-backed `0010` upgrade preservation. Commit `ba0a4d9` changed 327 lines across migration and migration tests for stage catalog/snapshots. The much broader layout commit `879d279` changed 963 lines across production and tests. This ticket is broader than one upgrade fixture because it owns a reusable multi-table graph and many rejection cases, but narrower than creating and structurally proving the full layout.
- Confidence is medium because the concrete schema, target files, case groups, and comparable diffs are available, but there is no existing exact complete-runtime fixture from which to measure reuse. The high range includes verbose SQL seed data, explicit stable ordering for every table, and a bounded production correction. No production Provenance graph snapshot, authenticated authority, or known implementation result is assumed; the Structure records only a locally verified compatibility export and its authority limitation (`01-structure-outline-runtime-identity-spine.md:87-89`).

## Scope Signals

| Signal | Evidence | Effect on scope |
| --- | --- | --- |
| Independently useful acceptance groups | Fixture/snapshot, local guards, and relational guards can be reviewed in sequence, but rejection cases are not useful or verifiable to the ticket standard without the shared seeded graph and unchanged-state assertion. | Against decomposition |
| Multiple durable state machines or external-effect protocols | None are implemented. The work tests inactive SQL constraints and explicitly excludes transitions, claims, progression, bootstrap, quarantine, and external-effect behavior. | Against promotion or decomposition |
| Distinct trust boundaries | One boundary: untrusted direct SQL versus the strict SQLite schema. `PRAGMA foreign_key_check` and unchanged-state proof apply uniformly to every case. | Against decomposition |
| Reusable framework plus consumers | The fixture and snapshot assertion are intentionally reusable by the following tagged-invariant child, but they are acceptance-bearing infrastructure owned by this ticket rather than a general production framework. Separating them would leave this ticket and its consumer without an independently meaningful vertical outcome. | Mild split signal, outweighed by coupling |
| Separately releasable or revertible parts | No part releases independently. This suite is one mandatory contribution to an atomic parent migration gate, and the ticket expressly says the gate remains unreleased until all sibling outcomes pass. | Against decomposition |
| One detailed Design covers the change | The accepted ancestor Design fixes the SQL/application enforcement seam, pointer ownership, same-run identity, current-row rule, append-only migration policy, and test boundary for the entire change. | Against promotion |
| Size admission trigger | The high estimate is 930 human-authored changed lines, below the 1,000-line admission trigger. The likely work is concentrated in one test suite with one conditional production file. | Supports a reviewable feature |

## Decision Rationale

The complete production-quality change remains one reviewable vertical proof: construct one valid graph, apply one shared rejection contract, and exercise all identity-spine contradictions allocated by the ticket. Both phases use the same database shape, trust boundary, invariant ownership, and verification result. Splitting local checks from relational checks would duplicate or temporarily relocate the fixture contract and would produce a first unit that does not satisfy the ticket's complete allocated matrix. Splitting the harness from its cases would create infrastructure without an independently useful acceptance outcome and complicate its sole-owner relationship with the following child.

Promotion is not warranted because there is one accepted Design and no independently designable runtime behavior, external protocol, or release outcome. Retaining an admitted large unit is unnecessary because the estimate does not cross the trigger and ordinary staged review can keep the single-file test change tractable. Research is not required: the ticket, accepted Design, Structure, schema, tests, and relevant repository history provide enough evidence for a medium-confidence range. The estimate remains advisory, and all test, recovery, integrity, and atomic-gate obligations stay in scope.

## Review Strategy

1. Review the fixture first against a written row/table inventory: parent rows in foreign-key order, historical and current runs, document and implementation revisions with valid tagged children, cross-run/cross-stage/cross-Generation identities, physical operations, same-run pointers, and the guarded Generation cursor. Confirm `PRAGMA foreign_keys` never turns off.
2. Review the snapshot/assertion contract separately before reading cases. Require explicit stable ordering for every seeded table, one failing statement per invocation, exact before/after graph equality, and an empty `PRAGMA foreign_key_check` result.
3. Review Phase 1 as a table-driven boundary matrix. Reconcile both bounds for every allocated ordinal and every unsupported run/revision/format/currentness literal against the ticket; do not accept tagged-payload cases as substitutes.
4. Review Phase 2 by relational invariant: paired and same-Generation cursor, one current run, global owner-crossing key, then pending/published/accepted same-run pointers. Each case must begin from a fresh valid fixture and mutate exactly one contradiction.
5. If any case succeeds unexpectedly, isolate the smallest `0011` correction in `src/store/migrations.ts`, verify it against existing structural metadata tests, and rerun the full migration-11 suite. Do not add triggers, semantic lifecycle enforcement, inferred rows, or a new migration without new accepted authority.
6. Run `bun test test/store/migrations.test.ts`, `bun run check`, and `git diff --check`; also retain the Structure's narrower `bun run typecheck` and `bun run effect:check` evidence if `check` does not expose them distinctly.
7. At final review, map every case to same-Generation cursor, one-current-run, owner-crossing uniqueness, same-run pointers, append-only seeded-history preservation, format/cursor guards, unchanged graph, and foreign-key integrity. Confirm tagged invariants, file-backed upgrade behavior, typed stores, runtime lifecycle behavior, and parent release remain unclaimed.

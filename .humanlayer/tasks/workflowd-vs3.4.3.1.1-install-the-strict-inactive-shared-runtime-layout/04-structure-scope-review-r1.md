# Post-Structure Scope Review: Install the Strict Inactive Shared Runtime Layout

## Verdict
`KeepLarge`

## Estimate
estimatedChangedLines:
  low: 940
  likely: 1430
  high: 2100
confidence: medium
decision: KeepLarge

| Surface | Structure outcome and obligations | Low | Likely | High |
|---|---|---:|---:|---:|
| Migration: frontier and Generation boundary (`src/store/migrations.ts`) | Retain the through-`0010` runner, append one migration, reconstruct or otherwise extend `qrspi_generations`, preserve all old shape/indexes, add the exact format literals and guarded current-stage/current-run cursor | 55 | 85 | 130 |
| Migration: run/revision identity spine (`src/store/migrations.ts`) | Strict StageRun and common StageRevision tables, composite identities and foreign keys, three same-run pointers, current-run partial uniqueness, literals, JSON/hash checks, and globally unique owner-crossing key | 150 | 220 | 310 |
| Migration: tagged payload and step family (`src/store/migrations.ts`) | One-to-one document and implementation payload tables plus ordered implementation-step rows and their variant/parent identity constraints | 110 | 160 | 230 |
| Migration: references, diagnostics, and operation ownership (`src/store/migrations.ts`) | Artifact, commit, and checkpoint references; bounded revision diagnostics; document and step operation-owner tables; role, publication hook, owner uniqueness, physical-operation uniqueness, and all cross-identity foreign keys/indexes | 180 | 270 | 390 |
| **Migration subtotal** | | **495** | **735** | **1060** |
| Tests: frontier, helpers, and Generation metadata (`test/store/migrations.test.ts`) | Migration order, complete strict-table inventory, reusable PRAGMA/sqlite-master metadata inspection, preserved Generation shape/index, format/cursor guards, and no backfilled cursor/runtime facts | 100 | 160 | 240 |
| Tests: run/revision identity metadata (`test/store/migrations.test.ts`) | Every column/nullability, composite key order, foreign-key mapping, same-run pointers, partial-current index, owner-crossing uniqueness, literals, and local JSON/hash/ordinal checks | 130 | 200 | 300 |
| Tests: tagged, reference, diagnostic, and ownership metadata (`test/store/migrations.test.ts`) | Complete payload/step/reference/diagnostic/ownership structural inventory, one-to-one boundaries, parent-child mappings, uniqueness, operation roles, publication hook, and accepted shape/literal checks | 180 | 280 | 420 |
| Tests: inactivity and append-only proof (`test/store/migrations.test.ts`) | Every new table empty after migration, no new runtime trigger or executable claim index, and no migration registration before the new frontier changed | 35 | 55 | 80 |
| **Test subtotal** | | **445** | **695** | **1040** |
| Production code outside the migration | Explicitly excluded by the ticket and Structure | 0 | 0 | 0 |
| Separate migration files | Migrations are defined inline in `src/store/migrations.ts` | 0 | 0 | 0 |
| Configuration | No configuration surface is required | 0 | 0 | 0 |
| Required documentation | No user or operator documentation change is required for an inactive schema | 0 | 0 | 0 |
| **Total** | | **940** | **1430** | **2100** |

## Evidence

- The accepted Structure has two implementation-bearing phases, both allocated above. Phase 1 maps to the frontier/Generation and run/revision migration rows plus their corresponding metadata tests. Phase 2 maps to tagged payloads, steps, three immutable-reference families, diagnostics, two operation-ownership families, and their metadata and inactivity tests.
- The parent obligations are also fully allocated: the append-only single migration and retained historical runner are in the frontier row; complete table/column/key/foreign-key/index/literal proof is in the four test rows; tagged-table, same-run-key, owner/operation, format/cursor, history, and inactivity controls are spread across their named migration and test rows.
- The accepted Design requires strict local relational enforcement rather than application-only checks: separate common and tagged revision records, StageRun-owned same-run pointers, one current run, ordered implementation steps, exact WorkflowOperation ownership, immutable artifact/commit/checkpoint references, a diagnostic record, owner-crossing identity, and publication-operation identity. Those requirements account for the breadth of DDL and metadata assertions even though runtime methods are excluded.
- The current baseline is compact but already substantial: `src/store/migrations.ts` is 640 lines and `test/store/migrations.test.ts` is 833 lines. The new work remains localized to those files, but the likely estimate adds roughly one existing migration file's worth of strict DDL and nearly one existing migration-test file's worth of structural proof.
- Repository history provides a relevant lower-complexity comparison. Commit `ba0a4d9` (`Add trusted stage catalog and snapshots`) changed these same two files by 325 lines: 35 migration lines and 292 test lines. That change introduced one strict stage-definition table and its coverage. The reviewed Structure adds a Generation boundary change and approximately twelve interrelated runtime tables, multiple composite pointer/ownership relationships, partial and global uniqueness rules, and a complete metadata inventory. Helper reuse should keep growth sublinear, which is reflected in the range rather than multiplying 325 lines by the table count.
- The current test style uses real SQLite and explicit `pragma_table_info`, foreign-key, index, and `sqlite_master` assertions. The ticket requires every structural element and literal, so a short snapshot-only test is not a production-quality substitute.
- No generated files, lockfiles, vendored code, formatter-only churn, direct invalid-write matrix, file-backed upgrade-preservation fixture, typed Schema/store API, runtime transition, claim, bootstrap, quarantine behavior, or neighboring lifecycle is counted.
- Exact final column lists for several payload/reference tables are not enumerated field-by-field in the child Structure. The accepted Design fixes their identities and shapes sufficiently for a range estimate, but that remaining DDL-detail variance limits confidence to medium.

## Scope Signals

- Independently useful acceptance groups: weak. The identity spine and tagged children can be reviewed in passes, but the ticket's useful outcome is the complete shared layout required by later siblings. An identity-only migration does not satisfy the accepted complete-layout boundary.
- Multiple durable state machines or external-effect protocols: against splitting. This child installs inert records only. It adds no transition machine, claimer, external-effect execution, bootstrap, quarantine action, or reconciliation lifecycle.
- Distinct trust boundaries: present but tightly coupled. Generation format/cursor authority, tagged revision identity, immutable references, and physical-operation ownership are distinct relational seams, yet their value is the complete cross-table foreign-key graph. Omitting either ownership hook or a tagged/reference family leaves the shared foundation incomplete.
- Reusable framework plus consumers: against splitting. There is no generic framework and consumer implementation here; there is one concrete relational layout consumed only by later tickets.
- Separately releasable or revertible parts: against splitting. The acceptance criteria require one append-only migration after `0010`. Shipping the identity spine first and completing that same migration later would edit applied history; using multiple migrations would change the accepted migration boundary. Production DDL without its exhaustive tests would also defer required correctness proof.
- One detailed Design covers the whole change: for keeping the unit coherent. The accepted ancestor Design defines the common/tagged model, ownership hooks, local SQL enforcement boundary, inactivity exclusions, and append-only migration rule as one capability.
- Review-size signal: strongly favors explicit admission handling. The high estimate is 2100 human-authored changed lines, above the 1000-line trigger, and most of the size is correctness-bearing DDL or proof rather than incidental churn.
- Structure-phase signal: the two phases are useful implementation and review checkpoints, but both modify the same migration and test suite and neither is safely releasable as the ticket's completed outcome.

## Decision Rationale

The complete change is larger than the normal review target, so admitting it without an explicit large-change strategy would understate the review burden. It is nevertheless one conceptually narrow, schema-only authority boundary: one numbered migration and the exhaustive structural proof for that migration.

The plausible decompositions are unsafe or artificial. Splitting after the identity spine either publishes an incomplete shared runtime schema, requires a later edit to migration history, or changes the accepted one-migration contract. Splitting tagged payloads, references, diagnostics, or ownership into separate deliveries leaves foreign-key and authority seams incomplete and makes later siblings depend on a partial foundation. Splitting production DDL from structural tests turns mandatory correctness evidence into deferred work. Splitting tests by table family alone creates review tasks without independent vertical outcomes and duplicates migration coordination.

There is no evidence of independently designable or prioritizable features: all table families are fixed by one accepted Design and are inert until later capabilities consume them. Missing field-level details create estimate variance but do not prevent a credible scope decision because the required table families, relationships, controls, files, and exclusions are explicit. The justified result is therefore to retain the atomic delivery while reviewing it in controlled passes.

## Review Strategy

1. Implement and review in the Structure's two phases on one branch, but do not release or treat Phase 1 as a completed migration. Keep the migration unshipped until the full Phase 2 schema and all tests are present.
2. In the first review pass, inspect only migration frontier integrity: unchanged `0001` through `0010`, the retained through-`0010` runner, registration of exactly one new migration, faithful Generation reconstruction if required, and absence of data inference.
3. In the second pass, inspect the DDL as an authority graph: Generation to StageRun, StageRun to common revision pointers, common revision to exactly one tagged payload, implementation ordering, immutable-reference ownership, diagnostics, document/step operation ownership, owner-crossing uniqueness, and publication-operation identity. Use a table-by-table checklist derived from the Structure so no parent obligation is unallocated.
4. In the third pass, reconcile every DDL column, primary-key position, foreign-key column order, index, uniqueness rule, check, and accepted literal against an explicit metadata assertion. Review helpers separately to ensure they report omissions rather than normalize them away.
5. In the fourth pass, verify negative scope structurally and by diff: all runtime tables are empty after migration; no new trigger, executable claim index, runtime API, store method, backfill, inferred conversion, or neighboring lifecycle exists; no production file outside `src/store/migrations.ts` changed.
6. Run `bun test test/store/migrations.test.ts`, `bun run typecheck`, and `bun run effect:check` after the complete migration and test inventory are assembled. Do not reduce the structural matrix to meet the estimate.
7. Present the final diff in reviewable logical segments even if it remains one delivery: frontier/Generation, run/revision spine, tagged payload/steps, immutable references/diagnostics, operation ownership, then exhaustive metadata and inactivity proof.

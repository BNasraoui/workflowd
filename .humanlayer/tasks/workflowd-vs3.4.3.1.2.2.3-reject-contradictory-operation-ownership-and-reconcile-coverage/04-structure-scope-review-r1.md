# Post-Structure Scope Review: Reject Contradictory Operation Ownership and Reconcile Coverage

## Verdict
`FeatureFit`

## Estimate
estimatedChangedLines:
  low: 320
  likely: 440
  high: 655
confidence: medium
decision: FeatureFit

| Surface | Low | Likely | High | Allocation |
| --- | ---: | ---: | ---: | --- |
| Production code | 0 | 0 | 0 | No store API, lifecycle, or runtime behavior is planned. |
| Migration | 0 | 0 | 45 | Contingency only: the smallest demonstrated `0011_qrspi_stage_runtime_layout` owner check, key, unique constraint, or composite foreign-key correction, plus exact metadata assertions. |
| Tests | 320 | 440 | 610 | Common-owner matrix, both tagged-owner matrices, duplicate-role and operation-reuse cases, executable coverage reconciliation, and use of the existing unchanged-graph/FK harness. |
| Configuration | 0 | 0 | 0 | No configuration surface is identified. |
| Required documentation | 0 | 0 | 0 | Coverage and atomic-gate reconciliation are executable test obligations; no separate repository documentation change is required by the ticket or Structure. |
| **Total** | **320** | **440** | **655** | Subtotals reconcile to the total range. |

The high estimate remains below the 1,000 changed-line admission trigger. It includes the conditional migration correction rather than assuming every currently declared constraint behaves as intended.

## Evidence

### Outcome Inventory

| Structure outcome | Concrete implementation surfaces | Obligations allocated |
| --- | --- | --- |
| Phase 1: common owner and physical operation disagreement | `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` | Unsupported operation/owner/role tags, two role/kind inversions, missing physical operation, physical-operation kind mismatch, fresh complete graph, exact graph preservation, enabled FKs, empty `foreign_key_check`. |
| Phase 2: tagged owner identity and tuple disagreement | `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` | Both fixed owner tags; document workflow/Generation/stage/revision identity and bounds; implementation workflow/Generation/stage/revision/position identity and bounds; common owner-kind/role tuple agreement; isolated valid setup before the rejection snapshot. |
| Phase 3: ownership reuse and coverage reconciliation | `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` | Duplicate `produce`/`publish` roles for document revisions and implementation steps; same-table operation reuse; both cross-owner reuse directions; mapping to the ticket acceptance subset; parent atomic-gate and authority exclusions. |
| Verification and release boundary | Existing repository scripts and the final test matrix | `bun test test/store/migrations.test.ts`, typecheck, Effect diagnostics, full `bun run check`, `git diff --check`, intended-constraint review, complete acceptance mapping, and no claim that this child releases the parent. |

The accepted Design hash cited by the Structure was locally verified as `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`. Its relevant decisions are that SQL owns local tags, checks, keys, foreign keys, and uniqueness; `workflow_operations` remains the shared physical lifecycle; D3 supplies exact operation ownership without producer, publisher, progression, or neighboring lifecycle authority; and tests use real SQLite. The cited graph export hash was also locally verified as `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`. This is evidence only of the Structure's stated local compatibility snapshot and does not establish production Provenance publication, authentication, or gate authority.

At the reviewed baseline, `test/store/migrations.test.ts` is 3,529 lines and already contains the complete tagged `runtimeFixture`, `seedValidRuntimeIdentitySpine`, deterministic `readRuntimeGraph`, and `expectIdentitySpineRejection` helper at lines 665-1087. The helper already proves rejected execution, exact before/after equality over 18 tables, enabled foreign keys, and an empty `PRAGMA foreign_key_check`, so those obligations do not require a second harness.

The current `0011` migration in `src/store/migrations.ts:1097-1176` already declares:

- the `(operation_id, kind)` physical-operation identity key and foreign key;
- fixed vocabularies for operation kind, owner kind, and role;
- the `produce`/`StageProduce` and `publish`/`ArtifactPublish` pairing check;
- exact document-revision and implementation-step parent foreign keys;
- tagged composite foreign keys to the common owner tuple;
- parent-plus-role primary keys; and
- per-tagged-table `UNIQUE (operation_id)`, with the common owner `operation_id` primary key preventing cross-owner common-spine reuse.

That makes a test-only result likely, while retaining migration contingency for behavior exposed by direct SQL.

Recent same-file repository changes provide concrete sizing evidence. Commit `2ad347f` added 180 lines for 12 parameterized tagged parent-identity cases, about 15 lines per case. Commit `f1ea901` added 333 lines for a larger parameterized payload matrix. Earlier identity-spine guard changes added 84 and 439 test lines (`65c6bf4` and `93069f5`). The reviewed Structure describes approximately 36 individual contradictions, but many share generated lower/upper-bound dimensions and one test loop; duplicate/reuse cases require more valid setup. Applying those observed densities yields the 320/440/610 test range rather than multiplying every case by a standalone-test cost.

The ticket snapshot exposed a pre-existing provisional size range. In accordance with the independent-review constraint, that range was not used as sizing evidence or as a target; the estimate above is derived from the Structure inventory, current files, case count, and repository change history.

No production implementation, store API, migration registration, configuration, generated output, lockfile, or standalone documentation surface is allocated. Payload, reference, diagnostic, semantic-hash, transition, claim, progression, bootstrap, quarantine, upgrade, legacy, producer, publisher, and neighboring-owner work remains excluded.

## Scope Signals

| Signal | Evidence | Effect on decision |
| --- | --- | --- |
| Independently useful acceptance groups | The three phases isolate common-owner, tagged-owner, and reuse evidence, but none is separately releasable and the ticket requires one reconciled ownership matrix. | Weak structural grouping, not a safe feature split. |
| Multiple durable state machines or external-effect protocols | None are introduced. Tests exercise static SQLite checks, keys, and foreign keys; physical operation execution and external effects remain out of scope. | Strongly favors one feature. |
| Distinct trust boundaries | All cases cross the same SQL-local trust boundary from direct writes to the `0011` ownership constraints. Semantic and lifecycle authority boundaries remain excluded. | Favors one feature. |
| Reusable framework plus consumers | The complete fixture, graph reader, and rejection helper already exist as a completed dependency. This ticket consumes them and does not create a new framework. | No framework/consumer decomposition is warranted. |
| Separately releasable or revertible parts | The ticket explicitly contributes only one portion of an atomic parent migration gate. Splitting phases would produce partial evidence with no release authority. | Favors one review unit. |
| One detailed Design covers the whole change | The accepted ancestor Design consistently assigns exact operation ownership and local relational invariants to D3 while reserving execution and progression elsewhere. | Favors one feature. |
| Review size and concentration | Likely 440 and high 655 changed lines, almost entirely adjacent in one test describe block, with at most one small migration correction. | Fits the review target without an admission decision. |
| Dependency and integration boundary | The complete fixture dependency is closed. Reference/diagnostic work is independent except for parent reconciliation, which remains outside this child. | No missing dependency prevents implementation of this scoped outcome. |

## Decision Rationale

`FeatureFit` is the best fit because the complete production-quality outcome is one SQL-local ownership proof using one existing fixture, one rejection harness, three tightly related ownership tables, and one accepted Design boundary. Its likely and high estimates are reviewable, every acceptance item maps to the same matrix, and the current schema makes broad production work unlikely.

`SplitFeature` would turn common-owner, tagged-owner, or reuse phases into partial proof fragments. They share the same acceptance matrix and cannot independently establish the ticket's reconciliation or atomic-gate obligation. `PromoteToEpic` is inappropriate because the phases are neither independently useful nor separately prioritizable features and introduce no distinct designs. `KeepLarge` is unnecessary because the estimate does not cross the admission trigger and no exceptional large-change strategy is needed. `NeedsResearch` is not warranted: the accepted Design, dependency status, Structure, exact schema, fixture/helper baseline, verification commands, and comparable changes provide enough evidence for a credible estimate and verdict.

The estimate remains advisory. If direct SQL reveals a gap, correctness, metadata proof, graph preservation, and all allocated cases remain part of this feature rather than deferred cleanup.

## Review Strategy

1. Implement the matrix tests-first inside the existing migration-11 describe block, retaining one fresh `runWithDatabase` database and one contradiction per named test.
2. Review Phase 1 by constraint boundary: local vocabulary, role/kind pairing, physical operation existence, and physical kind. Confirm each failure is not masked by another invalid value.
3. Review Phase 2 by tagged variant and coordinate dimension. Any spare valid operation/common owner must be inserted before `expectIdentitySpineRejection` captures its snapshot, and each tuple case must avoid primary-key collisions.
4. Review Phase 3 by intended key: parent-plus-role primary key, same-table `UNIQUE (operation_id)`, then both cross-owner directions through the common-spine tuple. Inspect setup rows separately from the rejected statement.
5. Require a named executable acceptance map covering every common check, exact parent FK, tagged tuple FK, role uniqueness rule, physical-operation uniqueness rule, unchanged-graph/FK proof, and parent allocation. Reject claims of payload, reference, diagnostic, semantic, producer, publisher, progression, or parent release coverage.
6. Permit an `0011` edit only after a named allocated test demonstrates a real gap. Keep it to the local constraint or key and extend exact metadata assertions; do not introduce triggers, runtime behavior, or compatibility machinery.
7. Run `bun test test/store/migrations.test.ts`, `bun run typecheck`, and `bun run effect:check` during the phases, then `bun run check` and `git diff --check` for the complete unit. Review failures must not be addressed by weakening tests, graph equality, foreign-key checks, or scope boundaries.
8. Treat this child's passing result as evidence for parent reconciliation only. It does not authenticate, approve, complete, or release the parent migration gate and does not establish a production Provenance graph snapshot.

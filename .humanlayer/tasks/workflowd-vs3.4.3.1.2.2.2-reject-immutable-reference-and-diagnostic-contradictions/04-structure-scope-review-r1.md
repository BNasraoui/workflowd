# Post-Structure Scope Review: Reject Immutable-Reference and Diagnostic Contradictions

## Verdict
`SplitFeature`

## Estimate
estimatedChangedLines:
  low: 596
  likely: 865
  high: 1186
confidence: medium
decision: SplitFeature

| Surface | Planned outcome | Low | Likely | High |
|---|---|---:|---:|---:|
| Production migration | Add only the two diagnostic JSON/SHA-256 nullable-pair checks in `src/store/migrations.ts` | 6 | 10 | 16 |
| Tests: artifact references | Parent authority, repository fields, bounds, and Git/content hash rejection in `test/store/migrations.test.ts` | 130 | 190 | 260 |
| Tests: implementation references | Commit-reference and checkpoint parent, ordinal, repository, collection, and hash rejection in `test/store/migrations.test.ts` | 280 | 400 | 550 |
| Tests: diagnostics | Parent, literal, bound, JSON, hash, four one-sided-pair cases, positive absence controls, exact DDL metadata, and final coverage reconciliation in `test/store/migrations.test.ts` | 180 | 265 | 360 |
| Other migrations | No additional migration or upgrade fixture is required | 0 | 0 | 0 |
| Configuration | No configuration change is required | 0 | 0 | 0 |
| Required documentation | No user-facing or repository documentation change is required; named executable cases carry the required reconciliation | 0 | 0 | 0 |
| **Total** |  | **596** | **865** | **1186** |

The range counts human-authored additions and substantive edits only. It excludes generated files, lockfiles, vendored content, formatting-only churn, QRISPI artifacts, and tracker changes.

## Evidence

- The Structure allocates three implementation-bearing phases and only two code files: `test/store/migrations.test.ts` for all phases and conditional or required changes in `src/store/migrations.ts` (`01-structure-outline-immutable-reference-diagnostics.md:27-32`, `39-45`, `65-72`, `92-100`). No migration, configuration, or documentation surface outside those files is named or implied by the accepted boundary.
- The current baseline is already deep: `test/store/migrations.test.ts` is 4,248 lines and `src/store/migrations.ts` is 1,185 lines. The complete graph, `seedValidRuntimeIdentitySpine`, and `expectIdentitySpineRejection` already exist at `test/store/migrations.test.ts:665-1141`, so this estimate includes no fixture construction or new snapshot harness.
- The four target tables and their present local checks are contiguous in `src/store/migrations.ts:932-1095`. Artifact references already point to document revisions; commit references point to implementation steps; checkpoints point to implementation revisions; diagnostics point to common revisions. The demonstrated production gap is limited to the absent equality checks after the nullable diagnostic JSON and hash checks at `src/store/migrations.ts:1068-1087`.
- Existing exact metadata coverage already inventories all four tables at `test/store/migrations.test.ts:3507-3655` and validates each DDL snippet at `test/store/migrations.test.ts:3805-3811`. Adding the two equality snippets is small, but the Structure also requires positive behavioral controls and complete named acceptance reconciliation.
- The Structure calls for separate wrong workflow, Generation, stage, and revision or step cases, separate lower and upper bounds, separate malformed/root/empty collection cases, and separate wrong-length/uppercase/non-hex hash cases. Counting the explicit obligations yields roughly 20-25 artifact cases, 25-30 commit-reference cases, 30-35 checkpoint cases, and 20-25 diagnostic rejection/control cases. Confidence is medium because implementation may compact repeated value cases into data tables, while parent-identity cases still need otherwise-valid full SQL statements.
- Comparable baseline changes support that range without using a known implementation size for this ticket. Commit `2ad347f` added 180 test lines for tagged parent-identity cases; `f1ea901` added 333 test lines for tagged payload constraints; and `70c9cd4` added 719 test lines for operation-ownership constraints. The current test style uses explicit SQL descriptors followed by a shared fresh-database loop (`test/store/migrations.test.ts:1183-1771`), which commonly costs about 10-20 changed lines per structurally distinct case and less for compact assignment/value matrices.
- The accepted Design places local shape, key, foreign-key, and uniqueness invariants in strict SQLite while reserving canonical hashes and cross-record semantics for typed code (`03-design-discussion-stage-runtime-state.md:168-172`). It separately defines immutable artifact, implementation-commit, and checkpoint shapes (`:210-214`) and bounded diagnostic evidence (`:186-194`), so the Structure's SQL-local boundary matches one detailed Design.
- The completed fixture dependency is present in the repository baseline and the ticket records `workflowd-vs3.4.3.1.2.2.1` as closed. No missing fixture, authority, authentication, or production Provenance evidence is assumed. The Structure's local content-addressed graph export remains only the stated local compatibility snapshot and is not treated as production Provenance publication.

## Scope Signals

| Signal | Evidence | Effect on decision |
|---|---|---|
| Independently useful acceptance groups | Artifact authority, implementation commit/checkpoint authority, and diagnostic pair completeness each produce a named executable SQL proof for a distinct record family. | Supports splitting into independently verifiable tasks. |
| Multiple durable state machines or external-effect protocols | None are added. All work concerns static migration constraints and direct-SQL rejection. | Against promotion to an epic; neutral on implementation-task splitting. |
| Distinct trust boundaries | Artifact rows are authorized by document revisions; commit rows by implementation steps; checkpoints by implementation revisions; diagnostics by common revisions. | Supports splitting along existing relational authority seams. |
| Reusable framework plus consumers | The complete graph and rejection helper are already implemented dependencies, not new framework work. Each proposed child consumes the same stable harness without owning it. | Makes a safe split possible without creating a framework child or duplicate fixture work. |
| Separately releasable or revertible parts | The ticket and parent gate explicitly say no child is separately releasable. Test-only reference matrices are independently revertible, while the diagnostic matrix and its two production checks must move together. | Against epic promotion; requires vertical children and preserves the parent's atomic release gate. |
| One detailed Design covers the whole change | The accepted ancestor Design covers all four reference/diagnostic families and their SQL-versus-semantic boundary. | Against `PromoteToEpic` and `NeedsResearch`. |
| Review size | The likely estimate is below 1,000 lines, but the 1,186-line high estimate crosses the admission trigger. The matrix also spans about one hundred isolated cases in a 4,248-line test file. | Requires an explicit scope decision and favors smaller review units. |
| Unsafe intermediate state | Artifact and implementation-reference children are evidence-only against existing constraints. The diagnostic child couples its failing cases, two local checks, positive controls, and metadata assertions. No proposed child leaves a knowingly weakened production change. | Against `KeepLarge`; the split is safe. |

## Decision Rationale

`SplitFeature` fits because this remains one coherent SQL-local feature under one accepted Design and one parent release gate, yet it contains three safe, independently verifiable implementation outcomes aligned with existing relational authority seams. The high estimate crosses the 1,000-line admission trigger, and reviewing roughly one hundred explicit SQL cases in one change would obscure omissions and isolated-case validity.

`FeatureFit` is weaker because it would admit the high-range review burden without using the Structure's natural phase and table-family boundaries. `PromoteToEpic` is too strong: the outcomes are not separately releasable or independently prioritizable product features, add no separate state machines, and remain covered by one detailed Design. `KeepLarge` is unnecessary because the evidence-only matrices can land independently and the only production correction can remain atomic with its own behavioral and metadata proof. `NeedsResearch` is not warranted because the accepted Design, current DDL, complete fixture, test harness, exact metadata test, and comparable repository changes provide enough evidence for a medium-confidence estimate.

## Proposed Decomposition

### T1: Prove Artifact-Reference Rejection

- **Vertical outcome:** Direct SQL rejects the complete allocated artifact-reference parent, repository, field-bound, Git hash, and content-hash contradiction matrix against a fresh complete graph.
- **Dependencies:** Completed fixture Bead `workflowd-vs3.4.3.1.2.2.1`; no dependency on T2 or T3.
- **Primary files:** `test/store/migrations.test.ts`.
- **Provisional estimate:** low 130, likely 190, high 260 changed lines.
- **Acceptance coverage:** Ticket acceptance criterion 1 in full; the artifact portion of exact before/after graph equality, enabled foreign keys, and empty `PRAGMA foreign_key_check`; the SQL-local D1/D4, C1/V1, and R1 boundary for artifact references.
- **Control and risk coverage:** Document-versus-implementation authority; wrong workflow, Generation, stage, and revision; provider/repository/full-name bounds and slash shape; empty path/media type; commit/blob/content hash length, lowercase, and hex shape; no canonical, content, repository-observation, or semantic-reference claim.
- **Recursive status:** Requires its own post-Structure scope review and is not an implementation-ready leaf.

### T2: Prove Implementation Commit and Checkpoint Rejection

- **Vertical outcome:** Direct SQL rejects the complete allocated implementation commit-reference and checkpoint parent, ordinal, repository, collection, and immutable-hash contradiction matrix against a fresh complete graph.
- **Dependencies:** Completed fixture Bead `workflowd-vs3.4.3.1.2.2.1`; no dependency on T1 or T3.
- **Primary files:** `test/store/migrations.test.ts`.
- **Provisional estimate:** low 280, likely 400, high 550 changed lines.
- **Acceptance coverage:** Ticket acceptance criterion 2 in full; the commit/checkpoint portion of exact before/after graph equality, enabled foreign keys, and empty `PRAGMA foreign_key_check`; the SQL-local D1/D4, C1/V1, and R1 boundary for implementation references.
- **Control and risk coverage:** Exact implementation-step and implementation-revision authority; wrong workflow, Generation, stage, revision, and step; lower/upper positions; checkpoint identity; repository bounds and shape; Git hash shape; malformed, wrong-root, and forbidden-empty required collections; collection, changed-path, and prepared-evidence SHA-256 shape; no collection-content, ordering, canonical-hash, or cross-row semantic claim.
- **Recursive status:** Requires its own post-Structure scope review and is not an implementation-ready leaf.

### T3: Correct and Prove Diagnostic Pair Completeness

- **Vertical outcome:** Add the two local nullable-pair checks and prove all allocated diagnostic parent, literal, bound, JSON, hash, absent-pair, and one-sided-pair behavior plus exact DDL metadata.
- **Dependencies:** Completed fixture Bead `workflowd-vs3.4.3.1.2.2.1`; no dependency on T1 or T2. It must land its production checks, rejection cases, positive controls, and metadata assertions atomically.
- **Primary files:** `src/store/migrations.ts`; `test/store/migrations.test.ts`.
- **Provisional estimate:** low 186, likely 275, high 376 changed lines.
- **Acceptance coverage:** Ticket acceptance criteria 3 and 4 in full; diagnostic portions of criteria 5 and 6; explicit parent-release non-completion from criterion 7; final named coverage reconciliation for this child ticket.
- **Control and risk coverage:** Wrong revision identity; supported reason literals; message and observed-kind/state bounds; expected/actual object JSON and local SHA-256 shape; all four one-sided pairs; either pair wholly absent; exact tagged-layout metadata; no trigger, required pair, expected-versus-actual comparison, canonical semantics, typed diagnostic, quarantine behavior, or parent release claim.
- **Recursive status:** Requires its own post-Structure scope review and is not an implementation-ready leaf.

### Allocation Accounting

| Allocation | Low | Likely | High |
|---|---:|---:|---:|
| T1 artifact references | 130 | 190 | 260 |
| T2 implementation commit references and checkpoints | 280 | 400 | 550 |
| T3 diagnostics, production correction, metadata, and final ticket reconciliation | 186 | 275 | 376 |
| Shared work outside children | 0 | 0 | 0 |
| Overlapping work counted more than once | 0 | 0 | 0 |
| Parent integration work outside children | 0 | 0 | 0 |
| Unallocated work | 0 | 0 | 0 |
| **Reconciled parent total** | **596** | **865** | **1186** |

The children share a dependency on the already-completed fixture and harness but do not re-own or re-estimate it. T3 owns the final ticket-level named reconciliation and the non-release statement; the parent Bead still owns cross-child integration and the atomic migration release gate. Tests, migration correctness, rejection recovery proof, foreign-key integrity, and metadata locking remain acceptance-bearing work rather than deferred cleanup.

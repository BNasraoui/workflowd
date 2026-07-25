# Post-Structure Scope Review: Prove Tagged Payload, Reference, and Operation-Ownership SQL Rejection

## Verdict
`SplitFeature`

## Estimate
estimatedChangedLines:
  low: 941
  likely: 1427
  high: 2100
confidence: medium
decision: SplitFeature

| Surface | Planned outcome | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| `test/store/migrations.test.ts`: fixture and harness | Extend the inherited identity-spine fixture through all tagged children, references, diagnostics, physical operations, common owners, and tagged owners; update complete-graph proof | 130 | 190 | 280 |
| `test/store/migrations.test.ts`: payload matrix | Tagged payload, source-set, JSON, hash, nullable-pair, implementation-step triad, ordinal, cross-variant, and wrong-parent rejection cases | 260 | 390 | 560 |
| `test/store/migrations.test.ts`: reference and diagnostic matrix | Artifact, commit, checkpoint, and diagnostic identity, repository, collection, JSON, hash, pair, literal, bound, and parent rejection cases plus DDL locking | 300 | 450 | 650 |
| `test/store/migrations.test.ts`: operation-ownership matrix | Common-owner kind/role/physical-operation checks, tagged-owner checks, duplicate-role checks, and same-table/cross-owner physical-operation uniqueness | 220 | 340 | 500 |
| `src/store/migrations.ts` | Demonstrated diagnostic expected/actual JSON/hash pair checks; contingency for another smallest local `0011` correction | 6 | 12 | 35 |
| Test integration and coverage reconciliation | Named matrix reconciliation, final complete-graph inventory, foreign-key proof, and suite-wide adjustments | 25 | 45 | 75 |
| Configuration, generated migration files, required documentation | No Structure outcome requires these surfaces | 0 | 0 | 0 |
| **Total** |  | **941** | **1427** | **2100** |

The likely and high estimates cross the 1,000-line admission trigger. The range counts human-authored additions and substantive edits only. It excludes formatter-only churn, lockfiles, generated files, and any unrelated repository work.

## Evidence

- The accepted Structure has three implementation-bearing phases and allocates nearly all work to `test/store/migrations.test.ts`, with a demonstrated production correction in `src/store/migrations.ts`. No migration registration, configuration, API, typed store, runtime, or required-documentation change is planned.
- The baseline files are already large: `test/store/migrations.test.ts` is 2,794 lines and `src/store/migrations.ts` is 1,185 lines. The relevant migration test describe-block starts at line 665, while the tagged-layout metadata assertion alone spans lines 1,946-2,372.
- The inherited fixture at `test/store/migrations.test.ts:718-935` currently seeds two physical operations and no implementation steps, references, diagnostics, common owners, or tagged owners. Extending all zero-count families shown at lines 962-981 requires substantial valid-row setup before rejection cases can be credible.
- The unchanged-graph helper at `test/store/migrations.test.ts:937-949` already snapshots every parent and runtime table, verifies rejection, compares the complete graph, checks that foreign keys remain enabled, and requires an empty `PRAGMA foreign_key_check`. Reuse reduces harness work but does not reduce the number of allocated SQL statements.
- The current `0011_qrspi_stage_runtime_layout` defines the relevant local checks and foreign keys at `src/store/migrations.ts:726-1176`. Diagnostic JSON and hashes are individually shaped at lines 1,068-1,086 but are not paired, directly supporting the Structure's small production correction rather than a speculative rewrite.
- Comparable repository evidence is material. The two focused identity-spine rejection commits added 439 and 84 lines to `test/store/migrations.test.ts` (523 total). The tagged ticket covers more table families and field dimensions than that predecessor. The file-backed upgrade comparison added 279 and changed 49 test lines, while the original inactive-layout change added 587 and changed 34 test lines plus 342 migration lines; these show that complete SQL evidence in this repository routinely occupies several hundred lines per coherent matrix.
- The Structure explicitly allocates malformed and wrong-root JSON, lower and upper ordinals, one-sided pairs and triads, reference shapes, diagnostic literals, role/kind disagreement, duplicate roles, and cross-owner operation reuse. Compact parameterization can keep the low case below the likely value, but complete one-statement isolation and readable SQL make a sub-1,000 high estimate unsupported.
- The accepted Design revision 3 SHA-256 independently matches `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`. It places local shape, keys, foreign keys, tags, ordinals, and uniqueness in strict SQLite while reserving semantic identity, canonical hashes, coordinated completeness, transitions, and progression for typed transactions.
- The cited graph export SHA-256 independently matches `6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2`. It is only a local content-addressed compatibility snapshot. No production Provenance publication, authenticated gate response, authoritative graph root, or production graph snapshot was supplied or inferred.

## Scope Signals

| Signal | Evidence | Effect on decision |
| --- | --- | --- |
| Independently useful acceptance groups | Payload/tag constraints, immutable-reference/diagnostic constraints, and physical-operation ownership constraints each prove a distinct family of the ticket's SQL-local acceptance matrix against the same complete graph | Supports implementation-task decomposition |
| Multiple durable state machines or external-effect protocols | None are introduced. The work tests inactive relational constraints and does not execute producer, publication, progression, claim, quarantine, or recovery lifecycles | Opposes promotion to independently designed features |
| Distinct trust boundaries | All cases stay inside direct SQL against real SQLite. Repository/reference identity and operation ownership are different data families, but not separate authentication or external trust boundaries in this ticket | Supports one Design with several review units |
| Reusable framework plus consumers | The predecessor owns the snapshot/rejection foundation; this ticket extends the fixture once and then has three matrix consumers. The extension must land before the dependent reference and ownership matrices | Supports dependency-ordered splitting without duplicating the harness |
| Separately verifiable or revertible parts | Each matrix can run through the same helper and can be reviewed or reverted without changing runtime APIs. The diagnostic pair correction belongs with its proving diagnostic cases | Supports safe implementation splits |
| Separately releasable parts | None. The ticket and parent explicitly keep the migration release gate atomic until all allocated children pass | Opposes epic promotion and forbids partial release claims |
| One detailed Design covers the whole change | Design decisions D1, D3, and D4 define tagged records, narrow operation/reference seams, and SQL-local invariant placement; D10 preserves neighboring ownership exclusions. Control C1 and verification V1 cover this ticket's SQL-local contribution to risk R1 | Supports one feature with child tasks rather than multiple Designs |
| Review concentration | Nearly all estimated lines accumulate in one already-large test file, and the likely total is about 1,427 lines | Strongly opposes treating the complete diff as one review unit |

The ticket contributes only the SQL-local portion of C1/V1 and R1 prevention evidence. It does not complete semantic Schema/hash checks, typed diagnostics, quarantine C4/C7, claim containment C11, or the parent V1/V4/V5 obligations.

## Decision Rationale

The change is one coherent feature under one accepted Design, but it contains three safe, independently verifiable implementation tasks and exceeds the review admission trigger on credible likely and high estimates. Splitting at the Structure's vertical outcomes keeps each review centered on one relational authority family while preserving one shared complete graph and one atomic parent release gate.

Treating the whole change as a normal-sized feature would put roughly 1,427 likely changed lines, mostly dense SQL fixtures and rejection cases in one file, into one review. Keeping it large is unnecessary because payload, reference/diagnostic, and ownership cases do not require unsafe intermediate runtime states: they are additive verification, and the only planned production edit travels with its direct diagnostic proof. Promotion to an epic would overstate independence because no child needs a new Design, lifecycle, trust boundary, or release decision. Research is not required because the accepted Structure, current schema and tests, predecessor harness, demonstrated diagnostic gap, and comparable commits provide enough evidence for a medium-confidence range and decomposition.

No test, migration correction, unchanged-graph proof, foreign-key proof, recovery-sensitive evidence, security boundary, or integration reconciliation is deferred as cleanup.

## Proposed Decomposition

| Child | Vertical outcome | Dependencies | Primary files | Low | Likely | High | Exact coverage | Recursive status |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| T1: Complete tagged graph and reject payload contradictions | A valid complete tagged graph plus direct-SQL proof for fixed tags, cross-variant/wrong-parent children, source sets, payload JSON/hash pairs, implementation-step triads, and step bounds | Predecessor Bead `workflowd-vs3.4.3.1.2.1`; no proposed-child dependency | `test/store/migrations.test.ts` | 390 | 580 | 840 | Ticket AC fixture extension; AC direct-SQL payload/tag/identity/JSON/hash/pair/triad/ordinal subset; every case unchanged graph and FK integrity; SQL-local D1/D4, C1/V1, R1; preserve D10 exclusions and semantic-boundary scenario | Requires its own post-Structure scope review; not an implementation-ready leaf |
| T2: Reject immutable-reference and diagnostic contradictions | Artifact, commit, checkpoint, and diagnostic local-shape rejection, including the smallest demonstrated diagnostic pair correction and exact metadata proof | T1 complete fixture | `test/store/migrations.test.ts`; `src/store/migrations.ts` | 306 | 462 | 685 | Ticket AC reference/checkpoint/diagnostic parent, ordinal, repository, collection, JSON, hash, pair, literal, and bound subset; demonstrated correction; unchanged graph/FK proof; SQL-local D1/D4, C1/V1, R1 and the local diagnostic shape relevant to R4 without claiming quarantine | Requires its own post-Structure scope review; not an implementation-ready leaf |
| T3: Reject contradictory operation ownership and reconcile coverage | Common and tagged owner proof for kind/role agreement, physical kind, exact parent, duplicate roles, and same-table/cross-owner physical-operation uniqueness | T1 complete fixture; may proceed independently of T2 except for final parent reconciliation | `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` only for a demonstrated local owner constraint gap | 220 | 340 | 500 | Ticket AC ownership and physical-operation uniqueness subset; complete matrix reconciliation and atomic-gate scenario; unchanged graph/FK proof; narrow D3 seam, D4, C1/V1, R1; preserves producer/publisher/progression ownership and D10 exclusions | Requires its own post-Structure scope review; not an implementation-ready leaf |

| Allocation account | Low | Likely | High |
| --- | ---: | ---: | ---: |
| T1 child work | 390 | 580 | 840 |
| T2 child work | 306 | 462 | 685 |
| T3 child work | 220 | 340 | 500 |
| Shared integration and parent coverage reconciliation | 25 | 45 | 75 |
| Overlapping work counted more than once | 0 | 0 | 0 |
| Unallocated implementation-bearing work | 0 | 0 | 0 |
| **Reconciled parent total** | **941** | **1427** | **2100** |

Shared integration is deliberately retained at the parent accounting level: final named-case reconciliation, complete row inventory, suite-wide graph/FK assertions, and the explicit proof that passing this ticket alone does not release the parent gate. The tracker must not be mutated by this review. If children are created later, the parent must retain this shared allocation and atomic completion condition.

## Review Strategy

Review and land the dependency frontier in T1, then T2 and T3. Keep each child diff limited to its named SQL family, require every invalid statement to use a fresh fixture through `expectIdentitySpineRejection`, and run the migration test file plus the Structure's type/static checks at each boundary. Review the diagnostic DDL correction together with its behavioral and metadata proof. Finish with one parent reconciliation review that maps every ticket acceptance item to executable cases and confirms that no typed store, lifecycle, trigger, semantic-hash, upgrade, legacy-conversion, neighboring-owner, Provenance, authentication, or release claim entered the diff.

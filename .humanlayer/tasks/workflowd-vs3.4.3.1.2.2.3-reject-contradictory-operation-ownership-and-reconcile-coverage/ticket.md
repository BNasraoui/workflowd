# Reject contradictory operation ownership and reconcile coverage

**Bead:** `workflowd-vs3.4.3.1.2.2.3`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Prove by direct SQL that the common operation-owner spine and both tagged owner tables agree on operation kind, physical WorkflowOperation kind, owner variant, operation role, exact parent identity, role uniqueness, and single physical-operation ownership. Reconcile this ownership matrix with the parent ticket allocation while preserving the complete-graph and atomic release-gate boundaries.

This child consumes the complete tagged fixture owned by the payload child and may proceed independently of the reference/diagnostic child except for final parent reconciliation. It contributes the operation-ownership portion of the parent SQL-local release-gate proof but is not separately releasable.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2-prove-tagged-payload-reference-and-operation-ownership-sql-rejec/01-structure-outline-tagged-sql-rejection.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1.2.2-prove-tagged-payload-reference-and-operation-ownership-sql-rejec/04-structure-scope-review-r1.md`

## Out of Scope

- Fixture extension and tagged payload, source-set, pair, triad, and step-bound rejection owned by the payload child.
- Immutable-reference and diagnostic rejection and the demonstrated diagnostic nullable-pair correction owned by the reference/diagnostic child.
- Producer, publisher, allocation, transition, claim, progression, bootstrap, quarantine, runtime execution, upgrade preservation, legacy conversion, or neighboring ownership lifecycles.
- Triggers, semantic hash guarantees, coordinated child completeness, or production changes beyond the smallest local owner constraint correction directly demonstrated by an allocated case.
- Completion or release of the parent migration gate before all allocated child outcomes and parent integration reconciliation pass.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- Direct SQL rejects common-owner rows with unsupported operation, owner, or role tags; `produce` paired with `ArtifactPublish`; `publish` paired with `StageProduce`; declared operation kind disagreeing with the physical WorkflowOperation; or missing physical operations.
- Direct SQL rejects tagged owner rows with wrong fixed owner tags; wrong document-revision or implementation-step parent identities; lower or upper invalid revision or step ordinals; or disagreement with the common owner-kind and operation-role tuple.
- Direct SQL proves one document revision cannot acquire duplicate producer or publication roles, one implementation step cannot acquire duplicate roles, one physical operation cannot be reused by another owner in the same tagged table, and one physical operation cannot cross from a document owner to an implementation-step owner through the common spine.
- Every invalid statement uses a fresh complete graph and proves rejection, exact before/after graph equality, enabled foreign keys, and an empty `PRAGMA foreign_key_check`.
- The named matrix is reconciled against common ownership checks, tagged parent and uniqueness constraints, role/kind agreement, physical-operation uniqueness, and the parent ticket ownership acceptance subset without claiming reference/diagnostic or payload coverage owned elsewhere.
- Coverage remains limited to the narrow D3 seam, D4, C1/V1, and R1; producer, publisher, progression, and D10 ownership exclusions remain intact. Any production edit is limited to the smallest demonstrated local `0011` owner constraint correction.
- Passing this child alone does not complete or release the parent migration gate.

## Scenarios

### Scenario: Reject an operation-ownership contradiction

**Given** a fresh complete tagged graph with valid physical operations, common owners, and both tagged owner variants
**When** direct SQL attempts one allocated kind, role, physical-operation, owner-tag, exact-parent, ordinal, duplicate-role, same-table-reuse, or cross-owner-reuse contradiction
**Then** SQLite rejects the statement, the complete graph is unchanged, foreign keys remain enabled, and `PRAGMA foreign_key_check` is empty

### Scenario: Reconcile ownership coverage without expanding authority

**Given** the complete named ownership matrix
**When** its cases are mapped to the parent ticket and accepted Design controls
**Then** every ownership and physical-operation uniqueness item is covered while producer, publisher, progression, neighboring ownership, semantic, and lifecycle authority remain excluded

### Scenario: Preserve the atomic migration gate

**Given** this operation-ownership child passes
**When** the payload or reference/diagnostic child or parent integration reconciliation has not passed
**Then** the parent migration outcome is not considered complete or releasable

## Notes

Recursive scope outcome T3. Dependency: T1 complete fixture (`workflowd-vs3.4.3.1.2.2.1`); may proceed independently of T2 except for final parent reconciliation. Primary files: `test/store/migrations.test.ts`; conditional `src/store/migrations.ts` only for a demonstrated local owner constraint gap. Provisional changed lines: low 220, likely 340, high 500. Exact acceptance/control/risk coverage: ticket AC ownership and physical-operation uniqueness subset; complete matrix reconciliation and atomic-gate scenario; unchanged graph/FK proof; narrow D3 seam, D4, C1/V1, and R1; preserve producer/publisher/progression ownership and D10 exclusions. Risks retained: role/kind disagreement, physical-kind disagreement, wrong tagged parent, duplicate owner roles, same-table physical-operation reuse, cross-owner physical-operation reuse, graph mutation after rejection, incomplete reconciliation, and authority expansion into neighboring lifecycles. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan. Shared integration remains at the parent and no passing child permits partial release.

## Dependencies

- `workflowd-vs3.4.3.1.2.2.1`: Complete tagged graph and reject payload contradictions (blocks)
- `workflowd-vs3.4.3.1.2.2`: Prove tagged payload, reference, and operation-ownership SQL rejection (parent-child)


---
name: qrspi-design-structure
description: Produce or review QRSPI Design revisions and Provenance-backed Structure artifacts using exact acceptance-package identities. Use for Design ownership or impact review, Design acceptance, or Structure coverage work.
---

# QRSPI Design and Structure

Read the bundled
[`references/qrspi-design-structure-contract.md`](references/qrspi-design-structure-contract.md)
before applying this checklist. It is the complete, locally available normative contract
for this installed skill version and prevails if this operational checklist ever differs;
do not resolve behavior from a network URL or mutable branch.
Repository maintainers generate that reference from the canonical
`docs/qrspi-contract.md` with `bun run skill:sync` and MUST commit it and review this
checklist with every contract change. `bun run skill:check` rejects reference drift and
records the exact source SHA-256 in the bundle. Do not restate or weaken those rules in an
artifact.

## Design sequence

1. Verify the request carries one complete `DesignAcceptanceScope`: WorkflowId,
   Generation, exact Design Git `ArtifactReference`, ordered source set and hash,
   WorkflowDefinition hash, and Design, promotion, and Structure policy revisions and
   hashes. The Structure policy must already be pinned from the selected
   WorkflowDefinition before Design publication. Stop as stale or incomplete if any
   scope field is absent or mismatched.
2. Produce the Design revision from only those inputs. Keep requirements, decisions,
   controls, ownership, impact, uncertainty, and source attribution explicit.
3. Run semantic-ownership review first with an identity, slot, and session distinct from
   the producer. Use only `OwnershipReady` or `ReviseDesign`. Do not start impact review
   unless ownership is ready.
4. Run impact-and-risk analysis with an identity, slot, and session distinct from both the
   producer and ownership reviewer, against the same Design and sources, without the
   ownership-review conclusions. Use only `ImpactReady`, `ReviseDesign`, or
   `NeedsRiskDecision`.
5. Route `ReviseDesign` to a new producer revision. Run synthesis for both other impact
   verdicts. For `NeedsRiskDecision`, record mitigation/control obligations and explicit
   residual-risk decisions; return to Design if resolving them changes Design semantics
   or exceeds current authority. For `ImpactReady`, preserve explicit controls and
   residual risks and never reinterpret the verdict as risk-free.
6. Present one human gate over the exact Design, ownership report, impact report,
   synthesis, obligations, and residual-risk decisions. Approval is invalid if any item,
   identity, policy, or package hash differs.
7. Treat approval only as authority to request Provenance promotion. Do not start
   Structure until the exact request has an authoritatively confirmed graph snapshot that
   carries the approved Structure policy identity.

**Design exit:** the exact package is human-approved, its promotion is authoritatively
observed, and the result pins the matching immutable graph snapshot. A newer Design
revision invalidates every earlier report, decision, response, approval, and promotion.

## Provenance handoff

1. Keep the complete Design, reports, synthesis, and package manifest canonical in Git.
   The package must reference their exact commits, blobs, and content hashes.
2. Account for every approved semantic item in the deterministic selection manifest.
   Select every implementation-bearing requirement, rule, decision, control, ownership
   assignment, and residual-risk disposition; give every permitted exclusion a typed
   policy reason.
3. Attribute selected native records and links to their sources, artifact, reviewer or
   synthesizer, approving human, Workflow Generation, and policy revisions. Never copy
   complete artifacts or operational state into Provenance.
4. Leave all CLI/schema mutation, ordering, validation, observation, retry, idempotency,
   and graph-snapshot production to workflowd-vs3.9. Before every repeated mutation
   attempt, require authoritative observation and reuse the same deterministic identity.
5. Accept only a result that matches the exact request, proves complete authoritative
   observation and selection, and pins an immutable graph snapshot carrying the same
   Design, promotion, and Structure policy identities.

## Structure sequence

1. Verify the accepted package, human response, promotion request/result, graph snapshot,
   and StructureInput all bind the same Design/source/Generation/WorkflowDefinition and
   Design, promotion, and Structure policy identities. Never select Structure policy
   after approval or substitute graph head or “latest” state.
2. Classify each in-scope semantic node before creating work. Map implementation-bearing
   requirements and accepted controls to terminal work or an explicit existing owner.
3. Apply cross-cutting constraints to every affected item. Carry residual-risk
   disposition, owner, conditions, and monitoring/follow-up. Preserve informational
   nodes as traceability without making tasks.
4. Cite the accepted graph authority and exact coverage edge for every task. Reviewer
   suggestions, evidence links, and informational nodes do not authorize work.
5. Check complete coverage and record the pinned snapshot in the artifact/result. Route
   projection mistakes to another Structure revision; route semantic or authority defects
   back to a new Design revision.

**Structure exit:** all implementation obligations and controls have terminal-work or
owner coverage, cross-cutting constraints and residual risks are carried, informational
nodes produce no spurious tasks, no task lacks authority, and the result binds the exact
accepted package and snapshot.

Later implementation/test/type/schema/commit/monitoring/alert/runbook evidence links do
not stale Structure when accepted semantics are unchanged. Approved semantic
supersession makes affected Structure and Plan outputs require reevaluation.

Before exit, exercise the four examples in **Required contract scenarios** in the bundled
normative contract: revision 3 versus revision 2, uncertain publication recovery,
evidence-only graph extension, and approved semantic supersession.

## Boundaries

- Do not implement or operate workers, stores, reviewers, gates, Provenance adapters,
  task sizing, child issue creation, arbitrary DAGs, Plan, or Implementation here.
- workflowd-vs3.4 owns linear stage execution, accepted-revision and Design-reentry state,
  deterministic promotion-request construction, and exact request/result handoff only.
- workflowd-vs3.5 owns independent reviews, synthesis, and bounded revision routing.
- workflowd-vs3.6 owns durable human gates, authenticated responses, Plannotator, and
  delivery.
- workflowd-vs3.9 owns all Provenance mutation, retry, idempotency, authoritative
  observation, and graph-snapshot production.

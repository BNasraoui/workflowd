---
name: qrspi-design-structure
description: Produce or review QRSPI Design revisions and Provenance-backed Structure artifacts using exact acceptance-package identities. Use for Design ownership or impact review, Design acceptance, or Structure coverage, capability-identity, and split-routing work.
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
2. Fix capability identity before anything else. Use an explicit accepted capability
   grouping if the package has one; otherwise mint exactly one capability per accepted
   decision that authorizes repository work, including verification-construction work;
   otherwise, with no decision layer, one per accepted implementation-bearing
   requirement. Derive identity from node roles, never from named IDs of a past ticket.
   Record each capability's dependencies, taking them from accepted dependency edges
   where the graph states them. A missing edge is not a missing dependency: derive the
   rest from what the accepted outcomes require of each other, and treat "no
   dependencies" as a claim you must justify. Order capabilities so none precedes a
   capability it depends on, and order independent ones by ascending exact graph node ID.
3. Do not merge capabilities that feel small or split capabilities that feel large. A
   capability that looks tiny stays a capability; one that looks enormous stays one
   capability and routes to `SplitFlowRequired`. If the accepted boundaries look wrong,
   that is a semantic defect for a new Design revision, not a Structure repair.
4. Classify every in-scope semantic node. Prohibitions, owner assignments, residual-risk
   dispositions, verification obligations, and informational sources mint no capability;
   attach each to the capabilities it constrains, proves, or informs, or to a named
   external owner. Create no delivery work from any of them alone.
5. Route each fixed capability from current repository evidence at the accepted baseline
   commit, cited by path and by symbol where the claim is about a declaration. Apply the
   four common checks, then the checks of every domain profile whose surfaces the
   capability touches, recording which profiles you applied and why. All applicable checks
   pass means `ImplementationReady`; any failure means `SplitFlowRequired`. A planned seam, including one another capability in
   this same run will build, is not evidence. A named seam counts as complete only when
   it already names and accepts every direct dependency interface. Unavailable evidence
   fails its check.
6. Keep estimates out of routing. No changed-line count, file count, task count, effort
   range, or threshold may appear as a check or influence a route; put any estimate in
   the advisory section only. Ordinary implementation detail inside an existing seam is
   not a reason to split.
7. Write the artifact in the required schema, in order, with one route per capability and
   the exact accepted graph binding and edge IDs. Check complete coverage and record the
   pinned snapshot in the artifact/result. Route projection mistakes to another Structure
   revision; route semantic or authority defects back to a new Design revision.
8. Stop at `AwaitingHumanStructureReview`. Run no split flow, Plan, or Implementation,
   create no child delivery issues or tracker records, change no product code, and make
   no commit, push, or pull request.

**Structure exit:** capability identity follows the accepted graph, every capability has
one evidence-cited route, all implementation obligations and controls have terminal-work
or owner coverage, cross-cutting constraints and residual risks are carried, informational
nodes produce no spurious tasks, no task lacks authority, the result binds the exact
accepted package and snapshot, and the run ends at `AwaitingHumanStructureReview`.

Later implementation/test/type/schema/commit/monitoring/alert/runbook evidence links do
not stale Structure when accepted semantics are unchanged. Approved semantic
supersession makes affected Structure and Plan outputs require reevaluation.

Before exit, exercise the eight examples in **Required contract scenarios** in the bundled
normative contract: revision 3 versus revision 2, uncertain publication recovery,
evidence-only graph extension, approved semantic supersession, independent producers
agreeing, a prohibition creating no work, a small capability staying
`ImplementationReady`, and routing stopping at human review.

## Boundaries

- Do not implement or operate workers, stores, reviewers, gates, Provenance adapters,
  task sizing, child issue creation, arbitrary DAGs, split flow, Plan, or Implementation
  here. `SplitFlowRequired` is a recorded route for human review, not a trigger.
- workflowd-vs3.4 owns linear stage execution, accepted-revision and Design-reentry state,
  deterministic promotion-request construction, and exact request/result handoff only.
- workflowd-vs3.5 owns independent reviews, synthesis, and bounded revision routing.
- workflowd-vs3.6 owns durable human gates, authenticated responses, Plannotator, and
  delivery.
- workflowd-vs3.9 owns all Provenance mutation, retry, idempotency, authoritative
  observation, and graph-snapshot production.

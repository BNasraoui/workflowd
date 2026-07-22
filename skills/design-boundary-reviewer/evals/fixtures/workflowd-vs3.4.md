# Evaluation Fixture: workflowd-vs3.4

## Source Snapshot Metadata

| Source | Revision | Completeness |
| --- | --- | --- |
| Current ticket | `workflowd-vs3.4@fixture-1` | Complete, including task, acceptance criteria, out-of-scope statements, and explicit clarification |
| One-hop issue graph | `workflowd-vs3.4-graph@fixture-1` | Complete, including parent, dependencies, dependents or blockers, and relevant siblings |
| Accepted Questions | `workflowd-vs3.4-questions@fixture-1` | Complete |
| Accepted Research | `workflowd-vs3.4-research@fixture-1` | Complete |
| Draft Design | `workflowd-vs3.4-design@fixture-1` | Complete |
| Architecture references | `qrspi-contract@fixture-1` | Complete for every cited ownership constraint |

## Current Ticket

ID: `workflowd-vs3.4`

Title: Run configurable QRSPI stages and publish their artifacts

Task:

- Implement configured Questions, Research, Design, Structure, Plan, and
  Implementation stages through a trusted `StageCatalog`.
- Let each serializable `StageDefinition` select a versioned built-in contract and
  agent harness plus input bounds, producer policy, artifact or checkpoint policy,
  automated-review policy, and human-gate policy.
- Resolve and decode the exact contract, delegate agent execution, validate its result,
  and return prepared output to the durable operation lifecycle.
- Publish document artifacts and implementation commits through separate exact-parent,
  exact-old operations.
- Advance `StageRun` only from authoritative publication, review, or gate outcomes.

Acceptance criteria:

- Load and validate one ordered server-owned workflow definition before use.
- Register all six built-in contracts and run enabled stages in deterministic order.
- Add a test contract through registration without a new queue, worker loop, store
  family, or central stage-kind switch.
- Decode bounded inputs tied to exact accepted sources.
- Keep harness execution unable to advance runs or publish Git state.
- Publish through signed exact-parent commits and exact-old remote updates.
- Let successor stages consume only accepted revisions and reject stale outcomes.
- Cover registration, extension, skip, success, retry, restart, stale generation,
  version recovery, uncertain publication, document revision, and implementation
  checkpoint handoff.

Out of scope:

- Repository-loaded stage code, prompts, schemas, or harnesses.
- Generic plugin loading or arbitrary stage DAGs.
- One worker or service tag per stage.
- Pull-request changes during QRSPI stage work.

Explicit clarification: This ticket owns the policy and reference seams needed for
later review and gate capabilities, not those downstream lifecycles.

## Parent

`workflowd-vs3`: Orchestrate bead-native QRSPI workflows with adversarial and human
review. Its epic acceptance criteria include independent review, synthesis, and durable
human gates. These are parent goals allocated across child tickets, not inherited scope.

## Dependencies

- `workflowd-vs3.3` (closed): Creates the workflow generation and initial operations but
  does not launch stage agents.

## Dependents and Blockers

- `workflowd-vs3.5`: Add adversarial review and synthesis to QRSPI stages. It owns blind
  reviewer fan-out, immutable contributions, synthesis, bounded revision rounds, and
  escalation of contested findings.
- `workflowd-vs3.6`: Implement durable human gates with Plannotator review. It owns gate
  records and revisions, responses, restart-safe waits, Plannotator execution and URLs,
  asynchronous fallback, expiry, and stale-response rejection.
- `workflowd-vs3.8`: Serve accepted QRSPI artifacts from private stable URLs. It is not
  relevant to the claims in this Design.

## Relevant Siblings

- `workflowd-vs3.7`: Finalize a completed QRSPI generation into a pull request. It owns
  final merge-candidate pull-request publication.

## Accepted Questions

- Which stable contract and reference types must the stage runtime expose so later review
  and gate work can attach without stage-kind conditionals?
- Which state transitions must exist before later tickets implement their workers?

## Accepted Research

- A stage definition must carry review and gate policy as trusted serializable data.
- `StageRun` needs states and typed references for published, reviewed, gated, and
  accepted revisions.
- The stage ticket needs extension seams for later operations, but implementing reviewer
  orchestration or durable gate execution would consume the neighboring tickets.

## Draft Design

1. Define and hash `WorkflowDefinition`, `StageDefinition`, contract references, harness
   references, artifact policy, automated-review policy, and human-gate policy.
2. Register six built-in `StageContract` values in one `StageCatalog`; resolve and decode
   each contract before execution.
3. Add one generic stage runner that calls the selected harness and validates prepared
   output without granting publication authority.
4. Add document and implementation revision models plus signed exact-parent,
   exact-old artifact publication operations.
5. Add typed `ReviewSubject`, `ReviewRoundReference`, and `GateReference` fields and
   `StageRun` transitions so future review or gate outcomes can select an accepted
   revision. For now, only no-review/no-gate policy advances locally.
6. For review-enabled stages, create `ReviewContribute` operations for every configured
   reviewer, collect immutable contributions, enforce blind execution, and handle
   reviewer timeout.
7. Add a `ReviewSynthesize` worker that resolves consensus, contested claims, revision
   requests, and human escalation.
8. Persist `Gate`, `GateRevision`, and idempotent gate responses; launch Plannotator,
   preserve asynchronous fallback, and recover pending waits after restart.

## Architecture References

`docs/qrspi-contract.md` says:

- The accepted ticket owns product meaning; architecture constrains implementation but
  does not allocate child-ticket scope.
- Stage definitions contain automated-review and human-gate policy.
- Stage runs include waiting-review and waiting-human transitions and accepted-revision
  pointers.
- Review uses `ReviewContribute` and `ReviewSynthesize` operations.
- Human gates have durable records, revisioned responses, and optional Plannotator.
- Missing runtime code is current-state evidence, not evidence that this ticket owns it.

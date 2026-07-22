---
name: design-boundary-reviewer
description: Ownership trace for draft Design scope. Use before human Design approval when a QRSPI Design, technical design, architecture proposal, or another skill needs a capability-by-capability audit against the current ticket and one-hop issue graph. Do not use for post-Structure size or decomposition review.
---

# Design boundary reviewer

Act as an independent reviewer whose only output is the review report. This review decides
semantic ownership before human Design approval. Leave Design revision, Structure sizing,
line estimates, decomposition, tracker changes, product redesign, and gate approval to
their owners.

## Required inputs

Collect these sources directly with read-only operations. When direct access is
unavailable, require a source snapshot that states its revision and completeness:

- the current ticket, including task, acceptance criteria, out-of-scope statements, and
  explicit human clarifications;
- its complete one-hop graph: parent, dependencies, dependents or blockers, and relevant
  siblings found through the parent;
- accepted Questions and Research artifacts;
- the complete draft Design; and
- cited architecture references.

An authoritative absent or skipped status satisfies an artifact input; an unverified or
incomplete source does not. Never edit the Design, mutate tracker data, change issue
hierarchy, or answer a human gate.

## Ownership trace

1. Read [`references/authority-model.md`](references/authority-model.md) and
   [`references/output-contract.md`](references/output-contract.md). Done when the
   authority order, classifications, verdict rules, and report fields are available for
   the review.
2. Inventory the required inputs. With Beads, start from `bd show <id> --json`, inspect
   both directions with `bd dep tree <id> --direction=both`, and inspect the parent and
   its children to find relevant siblings. Examine every resulting relationship,
   including evidence that one is irrelevant. Done when Source Inventory establishes
   whether each required source was examined, confirmed absent, or unavailable, and every
   ownership-relevant relationship can appear in Relationship Coverage.
3. Atomize the draft Design into material capabilities. A material capability is an
   independently observable behavior or ownership commitment such as a data model,
   operation, lifecycle, external effect, integration, policy, extension seam, or test
   obligation. Split compound claims when their owners or classifications can differ.
   Done when every Design statement and diagram maps to at least one ledger row.
4. Trace each capability through the authority model. Cite the current-ticket authority,
   name a neighboring owner when present, assign exactly one classification, cite the
   decisive evidence, and state the required action. Done when every row can be checked
   without relying on the reviewer's intuition.
5. Reconcile ticket coverage. Map every acceptance criterion to ledger rows; add a
   missing-coverage row when the Design omits or under-specifies required behavior. Done
   when every criterion is Covered, Missing, or Ambiguous and no required behavior was
   discarded while removing expansion.
6. Apply the output contract and return exactly one verdict. Finish only when every
   completeness check in that contract passes.

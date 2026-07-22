# Output contract

Return the following sections in this order and use the field names exactly.

```markdown
# Design Boundary Review

## Verdict
`ScopeClean | ReviseDesign | NeedsClarification`

## Human Summary
<Two to four sentences naming the decisive ownership result and next action.>

## Source Inventory
| Source | Status | Revision or evidence |
| --- | --- | --- |
| Current ticket, issue graph, accepted Questions, accepted Research, draft Design, or architecture reference | Examined, ConfirmedAbsent, or Unavailable | ... |

## Scope Ledger
| ID | Design claim | Current-ticket authority | Neighboring owner | Classification | Evidence | Required action |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | ... | ... | None or ticket ID | Required, RequiredEnablingSeam, OwnedByAnotherTicket, UnsupportedExpansion, or NeedsHumanClarification | ... | ... |

## Acceptance Coverage
| Criterion | Ledger IDs | Status | Evidence |
| --- | --- | --- | --- |
| ... | C1 | Covered, Missing, or Ambiguous | ... |

## Relationship Coverage
| Issue | Relationship | Ownership relevance | Evidence examined |
| --- | --- | --- | --- |
| ... | parent, dependency, dependent/blocker, or sibling | ... | ... |

## Unresolved Clarifications
None.
```

Replace `None.` when any source is `Unavailable` or any boundary is unresolved. For a
source gap, name the source and request the evidence needed to rerun the ownership trace.
For an ownership boundary, list its ledger IDs, competing interpretations, and one
answerable human question. Preserve clarification findings even when other rows already
require Design revision.

## Verdict rules

Apply the first matching rule:

1. `NeedsClarification` when any required source is `Unavailable`, any row is
   `NeedsHumanClarification`, or any acceptance criterion is `Ambiguous`.
2. `ReviseDesign` when there is no unresolved clarification and at least one row is
   `OwnedByAnotherTicket` or `UnsupportedExpansion`, an acceptance criterion is
   `Missing`, or a `Required` or `RequiredEnablingSeam` row needs Design changes.
3. `ScopeClean` when every required source is `Examined` or `ConfirmedAbsent`, every row
   is `Required` or `RequiredEnablingSeam`, every acceptance criterion is `Covered`, and
   every required action says to keep the claim as written.

Print only the selected verdict token inside the Verdict section. Do not add approval,
rejection, size, or decomposition verdicts.

## Completeness checks

The report is complete only when:

- each material capability has one ledger row and one classification;
- every numbered Design claim maps to its atomic ledger rows;
- compound claims with different ownership are split;
- Source Inventory includes the current ticket, complete one-hop issue graph, accepted
  Questions, accepted Research, draft Design, and every architecture reference;
- every acceptance criterion maps to one or more rows or a missing-coverage row;
- every ownership-relevant one-hop relationship found in the complete graph appears in
  Relationship Coverage, including relationships found irrelevant after review;
- every `OwnedByAnotherTicket` row names that ticket;
- every expansion and requested Design change cites decisive evidence;
- every ambiguity remains in both the ledger and Unresolved Clarifications; and
- every `Unavailable` source is requested in Unresolved Clarifications.

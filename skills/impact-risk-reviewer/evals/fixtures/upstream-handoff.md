# Evaluation Fixture: Canonical ownership report with separate binding

## Review Identity

| Field | Identity |
| --- | --- |
| Ticket | `change-808@rev-2` |
| Design | `design-change-808@rev-3` |
| Ownership report | `scope-change-808@artifact-1`, digest `sha256:scope808` |
| Review binding | `binding-change-808@rev-1` |
| Source set | `sources-change-808@rev-2` |
| Workflow Generation | `gen-93` |
| Policy revision | `design-acceptance-v2` |

## Source Snapshot Metadata

| Source | Revision | Completeness |
| --- | --- | --- |
| Current ticket | `change-808@rev-2` | Complete |
| Complete issue graph | `graph-change-808@rev-3` | Complete |
| Accepted Questions | `questions-change-808@rev-1` | Complete |
| Accepted Research | `research-change-808@rev-2` | Complete |
| Draft Design | `design-change-808@rev-3` | Complete, including one numbered decision |
| Ownership report | `scope-change-808@artifact-1` | Complete canonical Design Boundary Review shown below |
| Review binding | `binding-change-808@rev-1` | Complete authoritative envelope shown below |
| Architecture references | `readiness-rules@rev-4` | Complete |
| Current source | `readiness-service@commit-h12` | Complete affected source snapshot |
| Current tests | `readiness-tests@commit-h12` | Complete inventory and results |
| Deployment and operating model | `readiness-rollout@rev-2` | Complete |
| Observability and operational evidence | `readiness-signals@rev-5` | Complete |

## Authoritative Review Binding

The Design acceptance workflow issued this envelope; neither reviewer may edit it.

| Field | Bound value |
| --- | --- |
| Binding identity | `binding-change-808@rev-1` |
| Ticket | `change-808@rev-2` |
| Design | `design-change-808@rev-3` |
| Ownership report | `scope-change-808@artifact-1` |
| Ownership report digest | `sha256:scope808` |
| Source set | `sources-change-808@rev-2` |
| Workflow Generation | `gen-93` |
| Policy revision | `design-acceptance-v2` |

## Canonical Ownership Report

The complete upstream artifact uses the existing Design Boundary Reviewer output shape.
It intentionally has no Subject section or embedded workflow identity.

```markdown
# Design Boundary Review

## Verdict
`ScopeClean`

## Human Summary
The read-only readiness summary is required by the current ticket and does not absorb a neighboring lifecycle.

## Source Inventory
| Source | Status | Revision or evidence |
| --- | --- | --- |
| Current ticket | Examined | `change-808@rev-2` |
| Issue graph | Examined | `graph-change-808@rev-3` |
| Accepted Questions | Examined | `questions-change-808@rev-1` |
| Accepted Research | Examined | `research-change-808@rev-2` |
| Draft Design | Examined | `design-change-808@rev-3` |
| Architecture reference | Examined | `readiness-rules@rev-4` |

## Scope Ledger
| ID | Design claim | Current-ticket authority | Neighboring owner | Classification | Evidence | Required action |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Return a timestamped readiness summary and fail closed when signals are stale. | Criteria 1-3 | None | Required | Ticket and Design item 1 | Keep the claim as written. |

## Acceptance Coverage
| Criterion | Ledger IDs | Status | Evidence |
| --- | --- | --- | --- |
| Criteria 1-3 | C1 | Covered | Design item 1 |

## Relationship Coverage
| Issue | Relationship | Ownership relevance | Evidence examined |
| --- | --- | --- | --- |
| `initiative-80` | parent | Context only | Complete parent snapshot |

## Unresolved Clarifications
None.
```

## Current Ticket and Issue Graph

Return a read-only service-readiness summary. It must include the source timestamp, return
`Unknown` when any required signal is stale, and cause no state change or external effect.
The complete graph contains only parent `initiative-80`, which adds no child requirement.

## Accepted Questions and Research

The owner confirmed that `Unknown` is safer than an optimistic default. Research found
that all required signals already expose timestamps and that the current source has no
summary endpoint.

## Draft Design

1. **Timestamped readiness summary.** Read the existing required signals, return their
   source timestamps and a derived readiness state, and return `Unknown` when any signal
   exceeds the architecture-defined freshness bound. Perform no write or external effect.

## Architecture, Source, Tests, and Operations

The architecture requires fail-closed freshness checks. Existing signal readers are
read-only. Focused automated checks can prove fresh, stale, missing, and mixed-signal
states. Deployment uses the existing service path, and current monitoring already records
signal age.

## Decisive Risk Evidence

- Without the freshness rule, stale signals could report `Ready` after the underlying
  condition changed.
- The Design's timestamp output, fail-closed `Unknown`, existing signal-age monitoring,
  and focused checks provide complete current-ticket prevention and detection.
- No material residual tradeoff or Design correction remains. Return `ImpactReady`.

# Evaluation Fixture: Ambiguous Approval Boundary

## Source Snapshot Metadata

| Source | Revision | Completeness |
| --- | --- | --- |
| Current ticket | `reports-202@fixture-1` | Complete, including task, acceptance criteria, and out-of-scope statements |
| One-hop issue graph | `reports-202-graph@fixture-1` | Complete, including parent, dependencies, dependents or blockers, and relevant siblings |
| Accepted Questions | `reports-202-questions@fixture-1` | Complete |
| Accepted Research | `reports-202-research@fixture-1` | Complete |
| Draft Design | `reports-202-design@fixture-1` | Complete |
| Architecture references | `reports-approval-architecture@fixture-1` | Complete for the cited approval boundary |

## Current Ticket

ID: `reports-202`

Title: Add report approval policy hooks

Task:

- Evaluate configured approval policy when a report revision is submitted.
- Expose a typed hook that later approval delivery can invoke and observe.

Acceptance criteria:

- Policy evaluation returns `ApprovalRequired` or `ApprovalNotRequired` for an exact
  report revision.
- The typed hook exposes the decision and policy version to downstream work.
- This ticket does not send requests or notify approvers.

Out of scope:

- Approval-request delivery, reminders, and approver notifications.

## Parent

`reports-200`: Add report approvals. The epic requires durable decisions and approval
delivery but does not allocate every persistence responsibility.

## Dependencies

- `reports-201` (closed): Defines report revision identity and submission events.

## Dependents and Blockers

- `reports-203`: Deliver approval requests. It owns request delivery, reminders,
  approver responses, and notifications. Its task says it consumes the current approval
  decision, but it does not say which ticket persists that decision.

## Relevant Siblings

- `reports-204`: Show approval state in the report UI. It reads durable approval state but
  does not own writes.

## Accepted Questions

- Does the policy hook return a transient evaluation or the identity of a durable
  decision?

## Accepted Research

- Delivery and UI consumers need stable decision identity across restart.
- Persisting a decision could be a minimal enabling seam or the first operation in the
  downstream approval lifecycle. The current issue graph does not allocate it.

## Draft Design

1. Add pure approval-policy evaluation for an exact report revision and policy version.
2. Expose a typed `ApprovalPolicyHook` returning `ApprovalRequired` or
   `ApprovalNotRequired` plus the policy version.
3. Add an `ApprovalDecision` table and store one durable, idempotent decision before the
   hook returns. `reports-203` and `reports-204` will read this record.

## Architecture References

- Approval decisions must survive restart and use stable identity.
- Delivery must consume a current durable decision rather than recompute policy.
- The architecture contract does not assign decision persistence to `reports-202` or
  `reports-203`; the current ticket remains product authority.

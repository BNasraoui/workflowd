# Evaluation Fixture: External effect acknowledged before durable intent

## Review Identity

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | `change-202@rev-5`                             |
| Design              | `design-change-202@rev-2`                      |
| Ownership report    | `scope-change-202@rev-2`, verdict `ScopeClean` |
| Review binding      | `binding-change-202@rev-1`, authoritative envelope |
| Source set          | `sources-change-202@rev-4`                     |
| Workflow Generation | `gen-31`                                       |
| Policy revision     | `design-acceptance-v2`                         |

## Source Snapshot Metadata

| Source                                 | Revision                      | Completeness                                |
| -------------------------------------- | ----------------------------- | ------------------------------------------- |
| Current ticket                         | `change-202@rev-5`            | Complete                                    |
| Complete issue graph                   | `graph-change-202@rev-9`      | Complete                                    |
| Accepted Questions                     | `questions-change-202@rev-2`  | Complete                                    |
| Accepted Research                      | `research-change-202@rev-3`   | Complete                                    |
| Draft Design                           | `design-change-202@rev-2`     | Complete, including both numbered decisions |
| Ownership report                       | `scope-change-202@rev-2`      | Complete and identity-matched               |
| Review binding                          | `binding-change-202@rev-1`    | Complete authoritative envelope              |
| Architecture references                | `external-effect-rules@rev-8` | Complete                                    |
| Current source                         | `delivery-worker@commit-b72`  | Complete affected source snapshot           |
| Current tests                          | `delivery-tests@commit-b72`   | Complete inventory and results              |
| Deployment and operating model         | `worker-rollout@rev-4`        | Complete                                    |
| Observability and operational evidence | `delivery-signals@rev-3`      | Complete                                    |

## Current Ticket

Send an external delivery request once and expose its final local outcome.

Acceptance criteria:

1. Retry after process loss does not create a duplicate external delivery.
2. Every accepted request reaches a final delivered or failed local state.
3. Operators can reconcile uncertain external outcomes.

Out of scope: changing the external provider or its retention policy.

## Complete Issue Graph

- Dependency `identity-19` supplies the request identity and is complete.
- Dependent `history-73` displays the final local outcome.
- Sibling `provider-migration-90` owns a future provider replacement and is irrelevant.
- No neighboring ticket owns durability, retry, or reconciliation for this worker.

## Accepted Questions and Research

The provider accepts an idempotency key and exposes lookup by that key. A process can
lose power after the provider accepts a request but before the local database write.
Current tests cover provider rejection and local write failure separately but do not
exercise that interruption window.

## Ownership Report

`scope-change-202@rev-2` classifies sending, local outcome persistence, retry, and
reconciliation as `Required`. It finds no ownership expansion. Verdict: `ScopeClean`.

## Draft Design

1. **Send then persist.** The worker sends the provider request with a new random key. On
   provider acceptance it acknowledges the queue item, then asynchronously writes the
   delivered state to the local database.
2. **Retry and monitoring.** If no local delivered state exists after five minutes, an
   operator may enqueue a new request. A metric counts missing local outcomes and a
   runbook tells the operator to inspect provider logs.

## Architecture References

`external-effect-rules@rev-8` requires durable local intent and a stable operation key
before an external effect, retry with the same key, and reconciliation by that key before
declaring a new attempt.

## Current Source and Tests

The current source sends once without retry and stores a final state synchronously. The
new asynchronous ordering creates the interruption window. The provider test double can
record acceptance before forcing process termination. No current test proves recovery
from that point.

## Deployment and Observability

Workers roll gradually and can be paused. The missing-outcome metric detects the local
symptom after five minutes but cannot distinguish an accepted external delivery from a
request that never left the process. Provider logs are retained long enough for operator
reconciliation.

## Decisive Risk Evidence

- Process loss after external acceptance and before the local write causes an unknown
  local outcome. Decision 2 then sends a new random key, so one requested action can
  create two external deliveries.
- The failure is evidence-backed, affects interfaces, external effects, data, operations,
  and users, and violates all three acceptance criteria.
- Monitoring and a runbook do not prevent the unsafe ordering. The Design must durably
  record intent and a stable key before sending, reuse the key on retry, and reconcile
  before any new attempt. This is a Design correction, not a risk-acceptance question.

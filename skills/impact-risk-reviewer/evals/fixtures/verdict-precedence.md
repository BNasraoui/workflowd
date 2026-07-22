# Evaluation Fixture: Design correction precedes a residual-risk decision

## Review Identity

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | `change-707@rev-4`                             |
| Design              | `design-change-707@rev-2`                      |
| Ownership report    | `scope-change-707@rev-2`, verdict `ScopeClean` |
| Review binding      | `binding-change-707@rev-1`, authoritative envelope |
| Source set          | `sources-change-707@rev-3`                     |
| Workflow Generation | `gen-82`                                       |
| Policy revision     | `design-acceptance-v2`                         |

## Source Snapshot Metadata

| Source                                 | Revision                          | Completeness                                    |
| -------------------------------------- | --------------------------------- | ----------------------------------------------- |
| Current ticket                         | `change-707@rev-4`                | Complete                                        |
| Complete issue graph                   | `graph-change-707@rev-6`          | Complete                                        |
| Accepted Questions                     | `questions-change-707@rev-2`      | Complete except for the named capacity tradeoff |
| Accepted Research                      | `research-change-707@rev-4`       | Complete                                        |
| Draft Design                           | `design-change-707@rev-2`         | Complete, including both numbered decisions     |
| Ownership report                       | `scope-change-707@rev-2`          | Complete and identity-matched                   |
| Review binding                          | `binding-change-707@rev-1`        | Complete authoritative envelope                  |
| Architecture references                | `irreversible-effect-rules@rev-6` | Complete                                        |
| Current source                         | `dispatch-service@commit-g31`     | Complete affected source snapshot               |
| Current tests                          | `dispatch-tests@commit-g31`       | Complete inventory and results                  |
| Deployment and operating model         | `dispatch-rollout@rev-3`          | Complete                                        |
| Observability and operational evidence | `dispatch-signals@rev-5`          | Complete                                        |

## Current Ticket

Dispatch an irreversible external action from a durable queue and report its outcome.

Acceptance criteria:

1. An acknowledged queue item never loses an unrecorded external outcome.
2. Retry never creates a second logical external action.
3. Overload behavior is explicit before rollout.

Out of scope: selecting the business tolerance for delayed actions during exceptional
capacity exhaustion.

## Complete Issue Graph

- Dependency `durable-queue-20` owns the delivered queue primitive.
- No neighboring ticket owns dispatch ordering, identity, or overload controls.
- Parent and siblings add no current requirement.

## Accepted Questions and Research

The external system accepts a stable idempotency key but cannot reverse a completed
action. Research proves process loss can occur after external completion and before a
local result write. Capacity evidence establishes normal and peak load but does not
establish the acceptable outcome if the bounded queue remains full beyond its recovery
window.

The authorized owner has not selected whether exceptional excess work should be rejected
immediately, delayed beyond the normal objective, or blocked by disabling intake.

## Ownership Report

`scope-change-707@rev-2` classifies dispatch ordering, stable identity, durable outcome,
and overload behavior as `Required`. The capacity tolerance is a human product decision,
not neighboring scope. Verdict: `ScopeClean`.

## Draft Design

1. **Acknowledge then record.** After the external system reports completion, acknowledge
   the queue item and write the local completed outcome asynchronously. A missing local
   outcome may be retried with a new operation identity.
2. **Bounded queue.** Cap queued work and alert on saturation. The Design lists immediate
   rejection, extended delay, and disabled intake as unresolved overload options.

## Architecture References, Source, Tests, and Operations

The architecture requires durable local intent and stable operation identity before an
irreversible effect, reuse of that identity across retry, and reconciliation before a new
attempt. Current tests do not inject loss between external completion and local outcome.
The rollout can disable intake, and signals expose queue saturation and missing local
outcomes.

## Decisive Risk Evidence

- Decision 1 can lose the local record after the irreversible action, then retry under a
  new identity and create a duplicate action. The Design must change to persist intent
  and stable identity before dispatch and reconcile before retry.
- Decision 2 preserves a separate material tradeoff among immediate rejection, extended
  delay, and disabled intake during exceptional sustained exhaustion. No authority has
  accepted one option.
- Apply verdict precedence. Return `ReviseDesign`, preserve the capacity tradeoff, and
  defer its exact human question because the required new Design revision invalidates
  this report.

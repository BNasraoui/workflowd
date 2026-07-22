# Evaluation Fixture: Bounded provider outage with an unresolved operating choice

## Review Identity

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | `change-303@rev-4`                             |
| Design              | `design-change-303@rev-6`                      |
| Ownership report    | `scope-change-303@rev-6`, verdict `ScopeClean` |
| Source set          | `sources-change-303@rev-3`                     |
| Workflow Generation | `gen-44`                                       |
| Policy revision     | `design-acceptance-v2`                         |

## Source Snapshot Metadata

| Source                                 | Revision                       | Completeness                                                          |
| -------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| Current ticket                         | `change-303@rev-4`             | Complete                                                              |
| Complete issue graph                   | `graph-change-303@rev-5`       | Complete                                                              |
| Accepted Questions                     | `questions-change-303@rev-3`   | Complete except for the named business tolerance decision             |
| Accepted Research                      | `research-change-303@rev-5`    | Complete technical evidence                                           |
| Draft Design                           | `design-change-303@rev-6`      | Complete, including both numbered decisions and all feasible controls |
| Ownership report                       | `scope-change-303@rev-6`       | Complete and identity-matched                                         |
| Architecture references                | `queued-provider-rules@rev-4`  | Complete                                                              |
| Current source                         | `provider-adapter@commit-c18`  | Complete affected source snapshot                                     |
| Current tests                          | `provider-tests@commit-c18`    | Complete inventory and results                                        |
| Deployment and operating model         | `provider-operations@rev-7`    | Complete                                                              |
| Observability and operational evidence | `provider-slo-evidence@rev-10` | Complete twelve-month incident sample                                 |

## Current Ticket

Queue outbound requests during provider outages and resume delivery without duplication.

Acceptance criteria:

1. Temporary provider failure does not lose or duplicate an accepted request.
2. Users can see that delivery is delayed rather than complete.
3. Operators receive an owned signal and can pause, resume, or cancel queued work.

Out of scope: selecting the business response to an outage longer than the retained queue
window.

## Complete Issue Graph

- Dependency `durable-queue-11` owns the delivered queue primitive.
- Dependent `status-view-64` consumes the delayed and final states.
- Parent and siblings add no outage-tolerance requirement.
- No downstream ticket owns the long-outage business decision.

## Accepted Questions and Research

Technical owners accepted a 24-hour encrypted queue retention limit and confirmed that
requests can be cancelled before delivery. Research shows two provider incidents between
8 and 18 hours and no incident beyond 24 hours in the twelve-month sample. The likelihood
of an outage exceeding 24 hours is uncertain rather than zero.

No authorized owner has decided what outcome is acceptable after 24 hours: expire and
require user resubmission, extend retention with added privacy and cost exposure, or keep
the feature unavailable until provider recovery.

## Ownership Report

`scope-change-303@rev-6` classifies queue use, status, cancellation, and operational
controls as `Required`. The unresolved choice is a human residual-risk decision, not
neighbor-ticket scope. Verdict: `ScopeClean`.

## Draft Design

1. **Durable delayed delivery.** Persist the request with a stable idempotency key, show
   delayed state, retry with bounded backoff, and reconcile provider status before each
   retry. Encrypt queued payloads and delete them after the configured retention period.
2. **Operational control.** Alert on oldest queue age and retry saturation. Permit an
   operator to pause, resume, cancel, and reconcile. A disabled-by-default flag and queue
   drain guard contain rollout. The retention setting accepts any human-approved value
   within documented privacy and capacity constraints.

## Architecture References, Source, and Tests

The architecture requires durable intent, stable idempotency, visible delayed state,
bounded retry, cancellation, and payload lifecycle controls. The Design meets those
rules. Existing contract and integration tests prove stable-key retry, state transitions,
encryption, and deletion. A recovery drill proves pause, reconcile, and resume.

## Deployment and Observability

Rollout remains disabled until alert routing and the operator drill pass. Signals expose
oldest age, retry count, terminal failures, cancellation, and retained payload count. The
operator and privacy owner are named, but neither has authority to select the business
outcome after the approved retention window.

## Decisive Risk Evidence

- All feasible technical controls have owned, verifiable dispositions and no current
  Design defect is identified.
- A provider outage beyond the retention window leaves a material tradeoff among delayed
  user outcome, privacy and cost exposure, or feature unavailability.
- The report must return `NeedsRiskDecision` and ask one question that presents those
  exact options for `design-change-303@rev-6`; it must not choose or accept one.

# Evaluation Fixture: Safe handoff to a downstream control owner

## Review Identity

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | `change-404@rev-6`                             |
| Design              | `design-change-404@rev-3`                      |
| Ownership report    | `scope-change-404@rev-3`, verdict `ScopeClean` |
| Source set          | `sources-change-404@rev-5`                     |
| Workflow Generation | `gen-52`                                       |
| Policy revision     | `design-acceptance-v2`                         |

## Source Snapshot Metadata

| Source                                 | Revision                       | Completeness                                                         |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| Current ticket                         | `change-404@rev-6`             | Complete                                                             |
| Complete issue graph                   | `graph-change-404@rev-12`      | Complete                                                             |
| Accepted Questions                     | `questions-change-404@rev-2`   | Complete                                                             |
| Accepted Research                      | `research-change-404@rev-4`    | Complete                                                             |
| Draft Design                           | `design-change-404@rev-3`      | Complete, including both numbered decisions                          |
| Ownership report                       | `scope-change-404@rev-3`       | Complete and identity-matched                                        |
| Architecture references                | `event-handoff-rules@rev-7`    | Complete                                                             |
| Current source                         | `lifecycle-service@commit-d09` | Complete affected source snapshot                                    |
| Current tests                          | `lifecycle-tests@commit-d09`   | Complete inventory and results                                       |
| Deployment and operating model         | `event-rollout@rev-5`          | Complete                                                             |
| Observability and operational evidence | `event-signals@rev-4`          | Complete producer evidence; downstream evidence identified by ticket |

## Current Ticket

Publish a typed lifecycle event after the owned state transition commits.

Acceptance criteria:

1. Each committed transition exposes one stable event identity and schema.
2. Publication retries do not create a second logical event.
3. Exposure remains disabled until the downstream compliance control is ready.

Out of scope: retaining, searching, alerting on, or operating the downstream event
archive.

## Complete Issue Graph

- Dependency `event-outbox-14` owns the delivered transactional outbox primitive.
- Dependent `control-archive-405` explicitly owns event retention, search, alerting,
  operational response, and recovery for the compliance control.
- Sibling `analytics-70` may consume events later but owns no current control.
- Parent `initiative-40` adds no child behavior.

## Accepted Questions and Research

The downstream owner confirmed schema `lifecycle.v2`, stable event identity, and the
activation signal it will publish when retention, alerting, and recovery verification
pass. Research proves the outbox commits with the state transition and retries by stable
event identity.

## Ownership Report

`scope-change-404@rev-3` classifies the typed event, outbox write, and activation check as
`RequiredEnablingSeam`. It classifies archive retention, alerting, response, and recovery
as owned by `control-archive-405` and confirms the Design does not implement that
lifecycle. Verdict: `ScopeClean`.

## Draft Design

1. **Transactional event seam.** Add the typed event to the existing outbox in the same
   transaction as the lifecycle state change. Derive a stable event identity from the
   transition identity and retry publication with that identity.
2. **Safe activation handoff.** Keep publication behind a default-off activation guard.
   The guard can enable only after `control-archive-405` publishes its versioned readiness
   signal for the same schema. If readiness is withdrawn, stop new publication while the
   outbox retains pending events for bounded replay.

## Architecture References, Source, and Tests

The architecture requires transactionally coupled outbox entries, stable event identity,
versioned schemas, and an explicit activation dependency for downstream controls. Current
source already uses the outbox for another event. Automated component and contract tests
can prove transaction rollback, stable retry identity, schema compatibility, guard
default, readiness withdrawal, and bounded replay.

## Deployment and Operational Evidence

The producer deploys with publication disabled. Activation is a separate operation owned
by the release operator and requires the downstream readiness signal. Producer metrics
cover pending age, publish failures, guard state, and readiness revision. The downstream
ticket names its control owner, delivery phase, verification targets, and recovery drill.

## Decisive Risk Evidence

- Publishing before downstream retention and alerting are ready could create an
  uncontrolled compliance gap.
- The current ticket owns only the typed handoff and safe activation guard.
  `control-archive-405` owns the downstream control lifecycle.
- The default-off guard prevents exposure before the downstream controls exist, and all
  producer and downstream obligations have owners and deterministic verification.
- The correct verdict is `ImpactReady`; absorbing downstream retention or operations
  into the current Design would recreate scope bleed.

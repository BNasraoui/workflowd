# Evaluation Fixture: Controlled high-impact batch publication

## Review Identity

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | `change-101@rev-3`                             |
| Design              | `design-change-101@rev-4`                      |
| Ownership report    | `scope-change-101@rev-4`, verdict `ScopeClean` |
| Review binding      | `binding-change-101@rev-1`, authoritative envelope |
| Source set          | `sources-change-101@rev-2`                     |
| Workflow Generation | `gen-18`                                       |
| Policy revision     | `design-acceptance-v2`                         |

## Source Snapshot Metadata

| Source                                 | Revision                       | Completeness                                                                |
| -------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Current ticket                         | `change-101@rev-3`             | Complete task, criteria, exclusions, and clarifications                     |
| Complete issue graph                   | `graph-change-101@rev-7`       | Complete parents, dependencies, dependents, blockers, and relevant siblings |
| Accepted Questions                     | `questions-change-101@rev-1`   | Complete                                                                    |
| Accepted Research                      | `research-change-101@rev-2`    | Complete                                                                    |
| Draft Design                           | `design-change-101@rev-4`      | Complete, including both numbered decisions                                 |
| Ownership report                       | `scope-change-101@rev-4`       | Complete and bound to this Design and review identity                       |
| Review binding                          | `binding-change-101@rev-1`     | Complete; binds the ownership report digest to the Review Identity          |
| Architecture references                | `data-publication-rules@rev-5` | Complete                                                                    |
| Current source                         | `import-service@commit-a41`    | Complete affected source snapshot                                           |
| Current tests                          | `import-tests@commit-a41`      | Complete affected test inventory and latest results                         |
| Deployment and operating model         | `batch-rollout@rev-3`          | Complete                                                                    |
| Observability and operational evidence | `batch-signals@rev-6`          | Complete current metrics, alerts, and recovery drill                        |

## Current Ticket

Make large batch imports resumable without exposing partially validated data.

Acceptance criteria:

1. A failed import resumes without duplicating accepted records.
2. Readers see either the prior completed batch or the new completed batch, never a
   partial batch.
3. Operators can identify, stop, and recover a stalled import before publication.

Out of scope: changing downstream reader behavior or running downstream workflows.

## Complete Issue Graph

- Parent `initiative-10` groups import reliability work but adds no child requirements.
- Dependency `schema-55` owns the already-delivered unique import key.
- Dependent `reader-88` consumes only the completed batch pointer.
- Sibling `reporting-32` is unrelated to import execution or publication.
- No other graph node owns the controls in this Design.

## Accepted Questions

The owner confirmed that at most one active import per dataset is supported and that the
old completed batch remains readable until publication succeeds.

## Accepted Research

The current implementation writes the whole batch in one transaction. Production-sized
batches often exceed the transaction limit. Retry after a timeout has produced duplicate
staging rows in load tests, but no partial batch has reached readers because publication
is a separate pointer update.

## Ownership Report

`scope-change-101@rev-4` classifies both Design decisions as `Required`. It classifies
the completed-pointer response consumed by `reader-88` as ordinary output, not an
enabling seam. Verdict: `ScopeClean`.

## Draft Design

1. **Checkpointed staging.** Write bounded chunks to a staging generation keyed by the
   batch ID and stable source-row key. Commit each chunk, persist its checkpoint, and
   resume by ignoring already accepted keys. A per-dataset lease prevents concurrent
   active imports.
2. **Atomic publication and recovery.** Validate the complete staging generation before
   atomically replacing the completed batch pointer. Readers never query staging.
   Publish checkpoint age, rejection count, and lease state. Alert the import operator
   on a stalled checkpoint. Recovery stops the lease holder, reconciles accepted keys,
   resumes staging, and publishes only after validation. Rollout starts behind a disabled
   flag and enables one dataset at a time; disabling the flag prevents new imports while
   preserving the last completed pointer.

## Architecture References

`data-publication-rules@rev-5` requires immutable staging generations, atomic pointer
publication, stable idempotency keys, and a recovery path that reconciles before retry.

## Current Source and Tests

The current service has the completed pointer and source-row unique key but lacks chunk
checkpoints and the per-dataset lease. Existing tests prove pointer atomicity and unique
key rejection. Load evidence shows the current all-or-nothing transaction fails for
large batches. Test results are current for `commit-a41`.

## Deployment and Operations

The rollout flag defaults off. The operator owns enablement, alert response, lease stop,
and reconciliation. A recovery drill against a disposable dataset proved the pointer
remains on the old batch after injected staging failure and moves only after successful
resume and validation.

## Decisive Risk Evidence

- Without Decision 1, large ordinary batches are likely to exceed the transaction limit
  and lose the batch outcome across the system. Current rating basis: `Severe` impact and
  `Likely` likelihood.
- The Design's lease, stable key, checkpoints, isolated staging, atomic pointer,
  detection signal, rollout containment, and reconciled recovery provide complete owned
  dispositions. With those controls, the residual duplicate or partial-publication risk
  is bounded to `Minor` impact and `Rare` likelihood.
- No accepted material residual risk remains. The current high rating must not force a
  Design revision when the Design already contains complete verifiable controls.

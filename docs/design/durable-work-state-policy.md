# Durable Work State and currentness policy

Work State and Review Target currentness decide what a worker may claim, what it
may still write, and what a newer pull-request state cancels. Both used to be
spelled out wherever they were needed: state literals in migration constraints,
in the lease queue, in supersession SQL and in each queue's completion method;
target equality in the transition rules, in the GitHub evidence check and again
in SQL. Changing a state or a target field meant finding every copy.

This is where those rules live now.

## Owning modules

| Concern                                   | Module                                             |
| ----------------------------------------- | -------------------------------------------------- |
| Work State vocabulary and state groupings | `src/domain/work-state.ts`                          |
| Work State rendered as SQL                | `src/store/work-state.ts`                           |
| Review Target identity                    | `src/domain/review-target.ts`                       |
| Review Target and Generation currentness  | `src/store/currentness.ts`                          |

`src/domain/work-state.ts` names the states and the groupings that guards ask
for: which states a worker may claim, which states still owe an outcome and are
therefore cancelled by supersession, and which Publication states a newer Review
Request takes precedence over. `src/store/work-state.ts` turns those groupings
into the SQL fragments the queues share: `claimable`, `leaseHeldBy`,
`leaseExpired`, `stateIn` and `releaseLease`. Every durable queue — jobs,
publications, commands, reconciliations — claims and fences through those
fragments, so lease authority reads the same everywhere.

`src/domain/review-target.ts` owns target identity. `reviewTargetFieldNames` is
derived from the schema's fields, `sameReviewTarget` compares exactly those
fields, and both the pull-request transition rules and the GitHub head-evidence
check call it. `src/store/currentness.ts` holds the one mapping from those
fields to their durable columns and builds the currentness predicates from it.

The policy covers the four pull-request automation queues. The QRSPI kernel
(`workflow_operations`, `kernel_workflow_jobs`) runs its own lifecycle with its
own states, waits and gates, and is not governed by this module.

## Lifecycle

```
ready ──claim──▶ leased ──complete──▶ succeeded
  ▲                │
  │                ├─ reschedule with attempts left ─▶ retry_scheduled ─claim─▶ leased
  │                ├─ reschedule with attempts spent ▶ failed
  │                ├─ row cannot be decoded ─────────▶ data_error
  │                └─ newer Generation or Review Request ▶ superseded
  └─ requeue a failed fix ───────────────────────────────────────────────────┘
```

An expired lease is not a state change. The row stays `leased` and becomes
claimable again once `lease_until` has passed, which is why claimability is a
state set plus an expiry test rather than a state set alone. `superseded` exists
only for jobs and publications; commands and reconciliations answer an
observation that has already happened and are never superseded.

Supersession is deliberately asymmetric:

- A newer **Generation** cancels only work that still owes an outcome. A
  Publication that already succeeded keeps its state, because its comment is
  already on the pull request and is a record of what was said.
- A newer **Review Request** also supersedes publications that succeeded, so a
  sent comment stops counting as current for the pull request.

## Where the policy is deliberately not applied

`src/store/migrations.ts` keeps its own DDL literals. An applied migration is
history: it must keep emitting the constraints it emitted when it ran, so it
cannot read a vocabulary that later changes. The consistency that matters is
checked instead — `test/store/work-state-policy.test.ts` reads each durable
table's `CHECK (state IN (...))` constraint out of the live schema and compares
it against the vocabulary this policy declares.

## Changing the policy

- **Adding or retiring a Work State**: change `src/domain/work-state.ts` and the
  groupings it exports, add a migration that widens the `CHECK` constraint, and
  update the expected vocabulary in `test/store/work-state-policy.test.ts`.
- **Adding a Review Target field**: add it to `ReviewTarget`, add its columns to
  `reviewTargetColumns` in `src/store/currentness.ts`, and add a migration for
  the new columns. Domain equality and the SQL currentness predicate both extend
  themselves from the field list; `test/domain/review-target.test.ts` and
  `test/store/work-state-policy.test.ts` fail until the column mapping catches
  up.

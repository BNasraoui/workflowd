# Evaluation Fixture: Material deployment uncertainty

## Review Identity

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | `change-505@rev-2`                             |
| Design              | `design-change-505@rev-5`                      |
| Ownership report    | `scope-change-505@rev-5`, verdict `ScopeClean` |
| Review binding      | `binding-change-505@rev-1`, authoritative envelope |
| Source set          | `sources-change-505@rev-3`                     |
| Workflow Generation | `gen-63`                                       |
| Policy revision     | `design-acceptance-v2`                         |

## Source Snapshot Metadata

| Source                                 | Revision                     | Completeness                                                             |
| -------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| Current ticket                         | `change-505@rev-2`           | Complete                                                                 |
| Complete issue graph                   | `graph-change-505@rev-4`     | Complete                                                                 |
| Accepted Questions                     | `questions-change-505@rev-1` | Complete                                                                 |
| Accepted Research                      | `research-change-505@rev-3`  | Complete for application and schema behavior                             |
| Draft Design                           | `design-change-505@rev-5`    | Complete, including both numbered decisions                              |
| Ownership report                       | `scope-change-505@rev-5`     | Complete and identity-matched                                            |
| Review binding                          | `binding-change-505@rev-1`   | Complete authoritative envelope                                           |
| Architecture references                | `schema-compatibility@rev-9` | Complete                                                                 |
| Current source                         | `record-service@commit-e27`  | Complete affected source snapshot                                        |
| Current tests                          | `record-tests@commit-e27`    | Complete inventory and current results                                   |
| Deployment and operating model         | `deployment-order@unknown`   | Unavailable; supplied snapshot has no revision or completeness statement |
| Observability and operational evidence | `schema-signals@rev-2`       | Complete current application signals; no deployment-controller evidence  |

## Current Ticket

Add a nullable record attribute without interrupting mixed-version service operation.

Acceptance criteria:

1. Old and new service versions can read records during rollout.
2. Rollback to the old version preserves records written by the new version.
3. The attribute becomes required only in a later, separately approved change.

## Complete Issue Graph

- Dependency `schema-tooling-22` owns migration execution and is complete.
- Dependent `required-field-506` owns the later non-null transition.
- Parent and siblings add no current requirement.

## Accepted Questions and Research

The attribute is optional in this change. The serializer ignores unknown fields. Database
tests prove old reads tolerate the nullable column and new writes remain readable after
application rollback. Research did not inspect the deployment controller or establish
whether schema migration always precedes new application instances.

## Ownership Report

`scope-change-505@rev-5` classifies the nullable schema, dual-version serialization, and
rollback compatibility as `Required`. The later required-field lifecycle remains in
`required-field-506`. Verdict: `ScopeClean`.

## Draft Design

1. **Additive schema.** Add the nullable attribute with no default and preserve unknown
   attributes through old-version writes.
2. **Version guard.** New code checks schema capability before writing the attribute and
   leaves it absent when the capability is unavailable. Rollback reads and writes remain
   valid. A later ticket will backfill and require the field.

## Architecture References, Source, and Tests

The architecture permits additive nullable changes with capability checks and requires
schema-first deployment. Source and automated database, serialization, and rollback tests
support both Design decisions. No current evidence contradicts the Design.

## Observability and Missing Evidence

The application emits schema-capability and rejected-write metrics. The supplied
deployment description says only "the platform handles migrations" and has no revision,
ordering proof, rollback sequence, owner, or execution evidence. If new instances can
start before migration, users can receive write failures during ordinary rollout.

## Decisive Risk Evidence

- The Design already contains the correct compatibility and capability controls; the
  available evidence does not justify changing it.
- The unavailable deployment model leaves material uncertainty about whether the
  schema-first precondition holds in real rollout and rollback.
- No impact or likelihood level may be invented for the unknown deployment behavior.
- Return `NeedsRiskDecision` with one question asking the release authority to choose
  among obtaining versioned ordering evidence, preventing deployment, or explicitly
  accepting the stated uncertainty for `design-change-505@rev-5`.

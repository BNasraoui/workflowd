# Evaluation Fixture: Evidence-backed rule change without speculative expansion

## Review Identity

| Field               | Identity                                       |
| ------------------- | ---------------------------------------------- |
| Ticket              | `change-606@rev-7`                             |
| Design              | `design-change-606@rev-3`                      |
| Ownership report    | `scope-change-606@rev-3`, verdict `ScopeClean` |
| Review binding      | `binding-change-606@rev-1`, authoritative envelope |
| Source set          | `sources-change-606@rev-6`                     |
| Workflow Generation | `gen-71`                                       |
| Policy revision     | `design-acceptance-v2`                         |

## Source Snapshot Metadata

| Source                                 | Revision                         | Completeness                              |
| -------------------------------------- | -------------------------------- | ----------------------------------------- |
| Current ticket                         | `change-606@rev-7`               | Complete                                  |
| Complete issue graph                   | `graph-change-606@rev-8`         | Complete                                  |
| Accepted Questions                     | `questions-change-606@rev-4`     | Complete                                  |
| Accepted Research                      | `research-change-606@rev-6`      | Complete                                  |
| Draft Design                           | `design-change-606@rev-3`        | Complete, including one numbered decision |
| Ownership report                       | `scope-change-606@rev-3`         | Complete and identity-matched             |
| Review binding                          | `binding-change-606@rev-1`       | Complete authoritative envelope            |
| Architecture references                | `calculation-rules@rev-11`       | Complete                                  |
| Current source                         | `calculation-library@commit-f63` | Complete affected source snapshot         |
| Current tests                          | `calculation-tests@commit-f63`   | Complete inventory and current results    |
| Deployment and operating model         | `library-release@rev-4`          | Complete                                  |
| Observability and operational evidence | `calculation-signals@rev-5`      | Complete                                  |

## Current Ticket

Apply one documented rounding rule to a bounded calculation library.

Acceptance criteria:

1. Half values round away from zero at the final calculation boundary.
2. Intermediate values retain full precision.
3. Existing non-half and negative cases remain correct.

Out of scope: persistence, network interfaces, credentials, external providers,
deployment topology, or user-interface changes.

## Complete Issue Graph

- Parent `calculation-quality-60` groups rule corrections but adds no requirements.
- No dependencies or blockers affect this rule.
- Sibling `formatting-61` owns display formatting and does not consume intermediate
  calculation state.

## Accepted Questions and Research

The approved rule applies only once at the final boundary. Research found the current
implementation rounds intermediate values and identified six concrete half, negative,
and precision cases where that changes the result.

## Ownership Report

`scope-change-606@rev-3` classifies the final-boundary rule and focused regression
coverage as `Required`. It finds no interface or lifecycle expansion. Verdict:
`ScopeClean`.

## Draft Design

1. **Single final rounding boundary.** Carry the existing decimal type through all
   intermediate operations, apply the documented away-from-zero rule once when producing
   the final value, and preserve the public function signature.

## Architecture References, Source, Tests, and Operations

The architecture requires decimal arithmetic and one named rounding boundary. The
library has no I/O, configuration, credential access, external effect, or background
operation. Automated table-driven and property tests can prove the six regressions,
sign symmetry, unchanged non-half values, and absence of intermediate rounding. Release
uses the existing package path and monitors calculation disagreement samples.

## Decisive Risk Evidence

- The evidence-backed failure mode is an incorrect final value when intermediate half
  values are rounded. The Design removes the cause and has deterministic verification.
- Generic concerns about credential leakage, third-party outage, queue backlog, browser
  compatibility, and database corruption have no Design decision, affected surface, or
  trigger in this source set. They belong in Excluded Speculation without risk IDs,
  scores, or controls.
- Return `ImpactReady`. Inventing generic hazards would add unsupported obligations and
  dilute the material calculation risk.

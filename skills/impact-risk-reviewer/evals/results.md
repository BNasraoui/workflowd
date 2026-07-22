# Impact and Risk Reviewer Evaluation Results

## 2026-07-22: Current regression - Iteration 6

All seven fixtures ran in fresh `general` subagents against one exact staged skill
revision. Separate `analyzer` subagents graded every report against the same `evals.json`.

| Fixture                       | Verdict branch                            |       Assertions | Recorded evidence                                                                                                                                                                |
| ----------------------------- | ----------------------------------------- | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `impact-ready.md`             | `ImpactReady`                             |              7/7 | A supported `20/Critical` current rating did not force revision; complete owned controls reduced the stated residual risk to `2/Low`.                                            |
| `design-revision-required.md` | `ReviseDesign`                            |              8/8 | Unsafe irreversible-effect ordering required durable intent, stable identity, and reconciliation before retry; weak inspection was not recovery.                                 |
| `residual-risk-decision.md`   | `NeedsRiskDecision`                       |              9/9 | Unsupported long-outage likelihood remained `Unknown`; the full compound-trigger prevention choice remained `PendingDecision`; a status consumer did not become a control owner. |
| `downstream-owned-control.md` | `ImpactReady`                             |              9/9 | The current ticket retained only its event seam and safe activation guard; explicit downstream control ownership and distinguishing detection remained downstream.               |
| `unavailable-evidence.md`     | `NeedsRiskDecision`                       |              9/9 | Missing deployment-order evidence produced no invented score, control, owner, or false recovery claim and resulted in one answerable human question.                             |
| `unsupported-speculation.md`  | `ImpactReady`                             |              8/8 | One evidence-backed calculation risk remained; five generic candidates received no risk IDs, scores, controls, or verdict effect.                                                |
| `verdict-precedence.md`       | `ReviseDesign` before `NeedsRiskDecision` |              6/6 | The Design correction won the first-match collision while the separate residual tradeoff stayed unaccepted and deferred to the next revision.                                    |
| **Total**                     |                                           | **56/56 (100%)** |                                                                                                                                                                                  |

An independent final audit found no blocking semantic issue in the current skill or these
reports. It specifically rechecked effective detection, true recovery, explicit control
ownership, honest `Missing` and `PendingDecision` dispositions, score evidence, verdict
precedence, proportionate automation-first verification, and speculation exclusion.

The durable evidence is the fixture source, expectation text, verdict branch, and summary
above. Detailed generated reports and grader evidence remain in:

```text
/tmp/opencode/impact-risk-reviewer-workspace/iteration-6
```

The host did not return subagent model IDs, token counts, or timing, so those fields are
not claimed here. Executors used the `general` agent and graders used `analyzer`.

## Iteration history

### Iteration 6

All seven fixtures reran after the compound-trigger rule and typed repository integration
were complete. The exact staged revision passed 56/56 assertions. This run supersedes the
composite Iteration 4 and targeted Iteration 5 result as the current regression record.

### Iteration 4

The seven-fixture pass reached 55/56. The residual-risk fixture treated prevention as
`NotApplicable` by considering only the external outage rather than the full trigger,
which also included exposing accepted work beyond retention. The model now requires
`PendingDecision` when an unresolved option can remove a compound trigger condition or
prevent exposure. The targeted Iteration 5 rerun passed 9/9.

The new verdict-precedence fixture ran with and without the skill. The skill passed 6/6;
the baseline passed 5/6. Both selected `ReviseDesign` and preserved the deferred risk
question, while the baseline lacked formal honest control-gap dispositions.

### Iteration 3

The then-current six fixtures passed 46/46, but independent semantic review found control
box filling hidden by the assertions: weak signals could be labeled detection, rollback
could be labeled recovery of an already failed outcome, and consumer status could be
mistaken for downstream control ownership. The control model added `Missing` and
`PendingDecision`, stricter control-kind semantics, and explicit downstream lifecycle
authority. Iteration 3 is superseded.

### Iteration 2

Six fixtures ran once with the skill and once without it under 46 assertions:

| Configuration |        Result |
| ------------- | ------------: |
| With skill    | 43/46 (93.5%) |
| Without skill | 20/46 (43.5%) |

The failures exposed unsupported exact likelihood ratings. The model now states that
verification proving a control works does not establish the frequency of a defect or
control escape. Unsupported axes remain `Unknown` and unscored.

### Iteration 1

The first six-fixture suite scored 42/42 with the skill and 22/42 without it. Analysis
showed that the assertions allowed excessive Design atomization and over-weighted detailed
verification plans. Source decision IDs now remain stable, and verification is a compact
supporting obligation rather than an implementation test plan. Iteration 1 is superseded.

## Validation

- Skill Creator `quick_validate.py`: passed (`Skill is valid!`)
- `bun test skills/impact-risk-reviewer/scripts/risk-matrix.test.ts`: 8 passed, 0 failed,
  53 assertions
- `bunx prettier --check "skills/impact-risk-reviewer/**/*.{md,json,ts}"`: passed
- `npx skills add . --list`: found `impact-risk-reviewer` with its model-invoked
  description
- Product-specific and legacy-matrix scan: no matches

The calculator tests exhaust all 25 matrix cells, all five bands, the
`Significant x Rare = 4 / Low` example, canonical inputs, invalid inputs, stable CLI JSON,
and the absence of review verdicts from calculator output.

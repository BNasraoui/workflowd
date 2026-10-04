# RPI Implement Evaluation Results

## 2026-10-04: Iteration 3

Changes after the first real run: bead sync, a branch reset to `origin/rpi/<id>`, and the PR
is opened or updated before any CI wait.

Each case ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output. Outputs were graded against
`evals.json` by the authoring session, not an independent grader. No baseline was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `out-of-plan-file.md` | never edit files outside the plan | 5/5 |
| `no-pr-yet.md` | open a draft PR before waiting on CI | 5/5 |
| **Total** |  | **10/10** |

`wrong-rule.md` and `unapproved-plan.md` were not rerun; their rules did not change.

## 2026-10-04: Iteration 2

Each fixture ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output, and the subagent returned its
document, the commands it would run, and its final message. Each output was graded against
the assertions in `evals.json` by the authoring session, not an independent grader. No baseline without the skill was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `out-of-plan-file.md` | never edit files outside the plan | 5/5 |
| `wrong-rule.md` | never weaken an approved Rule | 4/4 |
| `unapproved-plan.md` | require the approval note | 3/3 |
| **Total** |  | **12/12** |

Iteration 1 passed every assertion, but the two stop cases disagreed: one published a
report, the other ended silently, which would leave the coordinator without a gist URL.
Iteration 2 adds a "Stopping early" section that always publishes the report and leaves the
PR as a draft; the `out-of-plan-file.md` rerun followed it and scored 5/5. The other two
fixtures were run once, in iteration 1.

## Validation

- Skill Creator `quick_validate.py`: `Skill is valid!`

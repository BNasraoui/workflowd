# RPI Coordinate Evaluation Results

## 2026-10-04: Iteration 1

Each fixture ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output, and the subagent returned its
document, the commands it would run, and its final message. Each output was graded against
the assertions in `evals.json` by the authoring session, not an independent grader. No baseline without the skill was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `woken-after-questions.md` | dispatch research with only the questions gist | 5/5 |
| `woken-after-plan.md` | stop for human approval | 4/4 |
| `human-approved.md` | record approval, then dispatch implement | 4/4 |
| **Total** |  | **13/13** |

In `human-approved.md` the subagent passed the human's choice on a reviewer decision to the
implement prompt, against the literal "add nothing else" rule. That was the right call, so
the skill now says to append such choices to the approval note and the prompt. The fixture
was not rerun after that wording change.

## Validation

- Skill Creator `quick_validate.py`: `Skill is valid!`

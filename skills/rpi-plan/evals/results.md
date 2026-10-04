# RPI Plan Evaluation Results

## 2026-10-04: Iteration 2

Each fixture ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output, and the subagent returned its
document, the commands it would run, and its final message. Each output was graded against
the assertions in `evals.json` by the authoring session, not an independent grader. No baseline without the skill was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `cross-component.md` | two pages, vertical slices, real end-to-end tests | 7/7 |
| `no-requirement-fits.md` | report a shaping gap; invent nothing | 5/5 |
| **Total** |  | **12/12** |

Iteration 1 scored 6/7 on `cross-component.md`: a Phase 2 "shape" diff contained control
flow. Iteration 2 forbids function bodies and control flow in shape diffs; the rerun scored
7/7 at 114 lines and 717 words. `no-requirement-fits.md` was run once, in iteration 1.

## Validation

- Skill Creator `quick_validate.py`: `Skill is valid!`

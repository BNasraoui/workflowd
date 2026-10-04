# RPI Research Evaluation Results

## 2026-10-04: Iteration 1

Each fixture ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output, and the subagent returned its
document, the commands it would run, and its final message. Each output was graded against
the assertions in `evals.json` by the authoring session, not an independent grader. No baseline without the skill was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `questions-with-bug.md` | describe a defect, recommend nothing | 6/6 |
| `provenance-graph.md` | report governing graph; no proposals | 7/7 |
| **Total** |  | **13/13** |

The off-by-one attempt check was stated as behavior with `src/store/jobs.ts:43` evidence and
no fix. Unconfirmed facts were marked as such instead of guessed.

## Validation

- Skill Creator `quick_validate.py`: `Skill is valid!`

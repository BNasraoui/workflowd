# RPI Research Evaluation Results

## 2026-10-04: Iteration 2

Changes after the first real run: bead sync with `-q` so research never prints the ticket,
a detached checkout of the questions commit, a read-only **Runtime evidence** section,
"not confirmed" for uninstalled dependencies and external tools, `--base <default branch>`,
and the expected empty commit without `.provenance/`.

Each case ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output. Outputs were graded against
`evals.json` by the authoring session, not an independent grader. No baseline was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `questions-with-bug.md` | describe a defect, recommend nothing; quiet bead; PR base | 6/6 |
| `runtime-and-external.md` | runtime evidence section; not confirmed; recommend nothing | 7/7 |
| **Total** |  | **13/13** |

The first `runtime-and-external.md` run used a fixture with invalid code (`for await` inside
`function*`), which the run flagged; the fixture was fixed and rerun. Its sync assertion was
also reworded from "the commands start with `bd dolt pull`" to "before any other `bd`
command", which is the rule; the first run read the questions gist before pulling. Fixtures
that give a short SHA led runs to resolve it with `git rev-parse`.

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

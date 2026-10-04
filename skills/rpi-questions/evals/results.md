# RPI Questions Evaluation Results

## 2026-10-04: Iteration 2

Changes after the first real run (workflowd-1o2): bead sync, a detached checkout of the
default branch with a full SHA, a re-read before publishing, the `gh gist create` exit-code
trap, and a concrete leak rule (existing mechanisms may be asked about; the new behavior may
not be named).

Each case ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output. Outputs were graded against
`evals.json` by the authoring session, not an independent grader. No baseline was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `retry-backoff.md` | questions must not leak the change | 7/7 |
| `existing-mechanism.md` | ask about existing mechanisms; keep ticket names; sync and publish | 7/7 |
| **Total** |  | **14/14** |

In `existing-mechanism.md` the run asked how `connectWithRetry` works and how the enqueue
connection behaves when the server goes away. That is today's behavior, so it is allowed,
but it sits close to the goal. The run kept the URL printed by `gh gist create` despite exit
status 1 and did not retry.

## 2026-10-04: Iteration 1

Each fixture ran once in a fresh general subagent that could read only the skill and its
fixture; the fixture stood in for all command output, and the subagent returned its
document, the commands it would run, and its final message. Each output was graded against
the assertions in `evals.json` by the authoring session, not an independent grader. No baseline without the skill was run.

| Fixture | Rule under test | With skill |
| --- | --- | ---: |
| `retry-backoff.md` | questions must not leak the change | 7/7 |
| `provenance-area.md` | graph questions; no leak | 6/6 |
| **Total** |  | **13/13** |

Both runs kept the bead's pointers verbatim and asked only about today's behavior. In the
Provenance fixture the subagent noted that the verbatim RFC URL (`0012-message-size`) hints
at the goal; the skill keeps pointers verbatim on purpose, so this is accepted.

## Validation

- Skill Creator `quick_validate.py`: `Skill is valid!`

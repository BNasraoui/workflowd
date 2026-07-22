# Design Boundary Reviewer Evaluation Results

## 2026-07-22: Iteration 3

Each fixture ran once in a fresh general subagent with the repository skill. Each report
was then graded against the current assertions in `evals.json`.

| Fixture | Verdict branch | With skill |
| --- | --- | ---: |
| `workflowd-vs3.4.md` | `OwnedByAnotherTicket` | 8/8 |
| `clean-enabling-seam.md` | `ScopeClean` | 6/6 |
| `ambiguous-approval-boundary.md` | `NeedsHumanClarification` | 7/7 |
| `unavailable-authority.md` | unavailable source | 5/5 |
| `unsupported-expansion.md` | `UnsupportedExpansion` | 6/6 |
| `missing-acceptance-coverage.md` | missing acceptance criterion | 6/6 |
| `required-design-change.md` | required row needs Design changes | 6/6 |
| **Total** |  | **44/44 (100%)** |

Iteration 3 adds explicit revision and completeness metadata for every fixture source. It
also isolates every `ReviseDesign` trigger: neighboring ownership, unsupported expansion,
missing acceptance coverage, and a required capability whose Design mechanism must
change. No baseline was rerun for this fixture-correction pass, so the Iteration 2 baseline
remains historical rather than directly comparable.

Iteration 2's `ScopeClean` fixture omitted the metadata required for a trusted source
snapshot. Iteration 3 supersedes its skilled result as the current regression record.

## 2026-07-22: Iteration 2

Each fixture ran once in a fresh general subagent with the repository skill and once
without it. Separate grader subagents applied the assertions in `evals.json` to both
reports.

| Fixture | Expected verdict | With skill | Without skill |
| --- | --- | ---: | ---: |
| `workflowd-vs3.4.md` | `ReviseDesign` | 8/8 | 5/8 |
| `clean-enabling-seam.md` | `ScopeClean` | 6/6 | 4/6 |
| `ambiguous-approval-boundary.md` | `NeedsClarification` | 7/7 | 3/7 |
| `unavailable-authority.md` | `NeedsClarification` | 5/5 | 3/5 |
| **Total** |  | **26/26 (100%)** | **15/26 (57.7%)** |

The baseline usually found the broad semantic boundary but did not produce the stable
verdict, exhaustive ledger, or full relationship coverage. The skill also distinguished
an explicit enabling seam from its downstream lifecycle and failed closed when authority
sources were unavailable.

Iteration 1 exposed two rule gaps: explicitly required seams overlapped `Required`, and
missing lower-order evidence could either disappear or erase clear current-ticket
ownership. Iteration 2 added the seam tie-break, Source Inventory, source-gap verdict, and
source-gap clarification behavior before the recorded runs above.

## Validation

- Skill Creator `quick_validate.py`: `Skill is valid!`
- `bunx prettier --check "skills/design-boundary-reviewer/**/*.{md,json}"`: passed
- `bun run check`: passed, including 515 tests
- `git diff --check`: passed

The run workspace was
`/tmp/opencode/design-boundary-reviewer-workspace/iteration-2`. It is not a durable test
artifact; the fixtures, assertions, expected verdicts, and summary above are the
repository regression record. Timing and token metrics were not available from the host.

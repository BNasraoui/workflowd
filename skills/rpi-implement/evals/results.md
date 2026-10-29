# RPI Implement Evaluation Results

## 2026-10-14: PR 118 review fixes

No eval script is present in this skill. Manually walked through evals 4 and 5
against the revised Finish instructions and their fixtures; no fixture commands
were executed, no gist was published, and no independent model rerun was performed.

- Eval 4 (`no-pr-yet.md`): pull Beads, verify approval, reset the RPI branch,
  implement and check the named files, commit/push, open the draft PR against main,
  then enter Finish. Observe CI only after updating the PR, verify its last pushed
  SHA, publish the report, and record both URLs before syncing Beads. All five
  expectations are satisfied in this author walkthrough.
- Eval 5 (`resident-push.md`): push the checked single phase, open the PR against
  main, then complete Finish's PR update, report, and final handoff without a watch
  or subscription. All three expectations are satisfied in this author walkthrough.
- Additional walkthrough: with multiple phases, a phase push does not enter Finish
  until the earlier phases are complete. In Finish's observation branch, missing or
  pending checks, timeout, transient/non-transient errors, and a changed head all
  reach step 3 with unverified CI and then the final report. An earlier SHA's green
  result cannot verify the final push. Early stops retain the same report fields
  and include the failing check link when applicable.

## 2026-10-13: Resident handoff regression (eval 5)

Manual walkthrough of `resident-push.md` with both the updated skill and injected
resident instructions; no fixture commands were executed and nothing was published.
The expected actions remain: push the checked phase, open/update the PR against main,
publish the implement report, then end the turn with CI handed to the coordinator.
No subscription or `gh pr checks --watch` is called. All three eval-5 expectations
are satisfied (3/3, author assessment; no independent model rerun). The injected
polling default now explicitly defers to this skill handoff. Other evals were not
rerun; their scope and approval rules are unchanged.

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

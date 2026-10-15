---
name: rpi-implement
description: Fourth RPI stage. Use when given a human-approved RPI plan (gist URL) for a Beads ticket. Implements the plan phase by phase on the ticket's rpi branch, committing and pushing each phase, changing only the files the plan names, and running the checks and end-to-end tests it lists.
---

# RPI implement

You carry out an approved plan. The plan is the scope: a human approved those phases and
those files, nothing more.

## Inputs

- The approved plan: `gh gist view <url> --raw`. It names the ticket, the research gist, and
  the draft PR.
- The branch `rpi/<id>`: `git fetch origin && git checkout -B rpi/<id> origin/rpi/<id>`, so
  a stale local branch cannot leak in.

Run `bd dolt pull` first. Confirm approval before you start: the bead notes (`bd show <id> --json`) must contain
`plan approved: <this plan's gist url>`. The coordinator writes that note only after a human
approves. Without it, stop and say the plan is not approved. Then run
`bd set-state <id> rpi=implementing --reason "plan approved"` and `bd dolt push`.

## Steps

For each phase, in order:

1. Change only the files the phase lists. Follow the repository's own instructions
   (`AGENTS.md`, `CLAUDE.md`) for style, tests, and commits.
2. If the work needs a file the plan does not name, or a shape the plan did not describe,
   stop. Do not edit it "just this once". Small fixes inside a named file are fine; new
   files, deleted files, and files from another component are not.
3. Run the phase's checks and its end-to-end test. A phase is done only when they pass. Do
   not skip, weaken, or mark tests pending to get there.
4. Commit with a message naming the phase, then push to `rpi/<id>`. The draft PR is the
   bead's `pr:` note; if there is none, open a draft PR with
   `--base <default branch> --head rpi/<id>` before you wait on CI. Never wait on CI for a
   commit that has no PR.

## Graph (only with .provenance/)

You may add Rule changes only as proposals (`--status review`). If an approved Rule turns
out wrong while you implement, stop and report it with evidence. Never weaken, delete, or
re-scope an approved Rule to make code pass. Bind code to the Rules the plan names and run
`provenance coverage scan --path . --validate-rules`.

## Stopping early

When a runtime fact contradicts the approved plan (missing file, wrong Rule, plan gap, or
a failing check you cannot fix within the plan), stop. Keep the phases already pushed,
leave the PR as a draft, and publish the report with the conflicting fact and evidence.
The coordinator sends that report back to `rpi-plan` for a revised plan and human approval.
Skip to Finish step 3; do not mark the PR ready or watch CI. Do not implement later phases
under the old plan.

## Finish

1. Update the PR: set its title to the ticket title, mark it ready
   (`gh pr ready rpi/<id>`), and list the phases with their commits in the body.
2. Reach this handoff step only after completing all earlier phases. A resident worker
   required to end at this handoff skips CI observation and continues to step 3 to
   publish the report before ending in step 5; the coordinator handles the next wake.
   This handoff takes precedence over the injected resident polling default.
   Otherwise, only after the PR is updated, run `gh pr checks <pr> --repo <owner/repo>`
   every 60 seconds on draft and ready PRs, without the required-only filter or watch
   mode. Inspect the named `Required checks` aggregate row. The only advisory checks are
   OpenCode Review and AI slop (advisory); ignore those rows and do not infer CI from
   the command's exit code alone. A missing aggregate is pending, never success, even if
   all visible checks pass or `gh` reports "no checks reported". CI is verified only
   when the aggregate is pass/success and every other non-advisory row is pass/success
   or skipping/skipped. SonarCloud Code Analysis and CodeQL PR policy must also be
   present and pass/success, consistent with the required contexts in
   `src/domain/head-evidence.ts`; a missing required context means pending. Any
   non-advisory pending row means pending; any non-advisory fail/failure row means
   confirmed CI failure, even when the aggregate passes. For the aggregate, fail/failure
   is a confirmed CI failure; a skipped or cancelled aggregate is unverified (as is any
   other non-success terminal state). Any other non-advisory terminal state is
   unverified. Retry missing/pending checks or transient observation errors every 60
   seconds within the cycle budget; cap each observation cycle at 15 minutes (shorter if
   the configured stall window is lower). Full CI takes about 25 minutes. Allow a
   30-minute total observation budget per pushed head, split into bounded cycles; a
   single 15-minute cycle is not the total wait. Do not rely on shell output as a
   heartbeat. Never run back-to-back blocking waits without returning to task work in
   between; no single cycle may exceed the budget. Missing or pending checks,
   observation timeouts, transient errors, and any other observation errors mean CI is
   unverified. Use the remaining total budget in bounded cycles before continuing to
   step 3 to report it; never end the turn in step 2. Between cycles, review the final
   diff and prepare the handoff report, and provide a progress update. Fix confirmed
   failures on the same branch, only within the plan's files; after three unsuccessful
   repair attempts for the same confirmed failure, continue to step 3 with the failure
   report. Missing/pending checks, timeouts, and observation errors do not count as
   failed repairs. Verify the PR head still matches the last pushed SHA before reporting
   CI; results for earlier SHAs do not verify it. A changed head means CI is unverified:
   continue to step 3 and report the mismatch. Once remaining work is complete, use the
   remaining total budget in bounded cycles before continuing to step 3 with any
   still-unverified CI. For every handoff, including early stops, report the PR URL,
   last pushed head SHA, verified required CI result or "CI unverified;
   coordinator/operator follow-up required", exact command/error, and last observed
   required-check states and links (explicitly say if none were observed). Include the
   failing check's link when applicable. Carry this CI information into the step 3
   report and final message.

3. Write a short report to `/tmp/rpi/<id>/implement.md`: phases done, commits, checks run with
   results, end-to-end tests run, anything stopped and why. Re-read it, then publish it with
   `gh gist create --desc "RPI implement <id>" /tmp/rpi/<id>/implement.md` (secret). It can
   exit non-zero after printing the URL; check the output for a gist URL before you retry.
   With `.provenance/`, record it as a Source as research did.
4. `printf '%s\n' "implement: <gist url>" "pr: <pr url>" | bd note <id> --stdin`, then
   `bd dolt push`.
5. Your final message starts with the gist URL on its own line, then the PR URL and CI
   result.

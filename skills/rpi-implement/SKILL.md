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
2. Only after the PR is updated, watch CI to the end (`gh pr checks <pr> --watch`). Fix failures on the same branch, only
   within the plan's files. A resident worker that must end its turn after pushing instead
   opens or updates the PR, publishes the report, and ends its turn. It never subscribes
   to CI; the coordinator handles the next wake.
3. Write a short report to `/tmp/rpi/<id>/implement.md`: phases done, commits, checks run with
   results, end-to-end tests run, anything stopped and why. Re-read it, then publish it with
   `gh gist create --desc "RPI implement <id>" /tmp/rpi/<id>/implement.md` (secret). It can
   exit non-zero after printing the URL; check the output for a gist URL before you retry.
   With `.provenance/`, record it as a Source as research did.
4. `printf '%s\n' "implement: <gist url>" "pr: <pr url>" | bd note <id> --stdin`, then
   `bd dolt push`.
5. Your final message starts with the gist URL on its own line, then the PR URL and CI
   result.

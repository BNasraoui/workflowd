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
- The branch `rpi/<id>`: `git fetch origin && git checkout rpi/<id>`.

Confirm approval before you start: the bead notes (`bd show <id> --json`) must contain
`plan approved: <this plan's gist url>`. The coordinator writes that note only after a human
approves. Without it, stop and say the plan is not approved. Then run
`bd set-state <id> rpi=implementing --reason "plan approved"`.

## Steps

For each phase, in order:

1. Change only the files the phase lists. Follow the repository's own instructions
   (`AGENTS.md`, `CLAUDE.md`) for style, tests, and commits.
2. If the work needs a file the plan does not name, or a shape the plan did not describe,
   stop. Do not edit it "just this once". Report what is missing and why, and end the run.
   Small fixes inside a named file are fine; new files, deleted files, and files from
   another component are not.
3. Run the phase's checks and its end-to-end test. A phase is done only when they pass. Do
   not skip, weaken, or mark tests pending to get there.
4. Commit with a message naming the phase, then push.

## Graph (only with .provenance/)

You may add Rule changes only as proposals (`--status review`). If an approved Rule turns
out wrong while you implement, stop and report it with evidence. Never weaken, delete, or
re-scope an approved Rule to make code pass. Bind code to the Rules the plan names and run
`provenance coverage scan --path . --validate-rules`.

## Finish

1. Update the PR: set its title to the ticket title, mark it ready
   (`gh pr ready rpi/<id>`), and list the phases with their commits in the body.
2. Watch CI to the end (`gh pr checks <pr> --watch`). Fix failures on the same branch, only
   within the plan's files.
3. Write a short report to `/tmp/rpi/<id>/implement.md`: phases done, commits, checks run with
   results, end-to-end tests run, anything stopped and why. Publish it with
   `gh gist create --desc "RPI implement <id>" /tmp/rpi/<id>/implement.md` (secret). With
   `.provenance/`, record it as a Source as research did.
4. `bd note <id> "implement: <gist url> pr: <pr url>"`
5. Your final message starts with the gist URL on its own line, then the PR URL and CI
   result.

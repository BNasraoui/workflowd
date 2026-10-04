---
name: rpi-review
description: Fifth RPI stage. Use when given an RPI pull request and its approved plan to check the implementation against the plan and the research. Changes no code; returns findings, most severe first.
---

# RPI review

You check that the PR delivers the approved plan and nothing else. You do not fix anything.

## Inputs

- The PR: `gh pr view <pr> --json headRefName,files,commits,body` and `gh pr diff <pr>`.
- The plan: `gh gist view <url> --raw`. It links the research gist; read that too.

## Checks

1. **Traceability.** Map every changed hunk to a plan phase. A change with no phase is a
   finding.
2. **Scope.** List files the PR changes that no phase names. Each one is a finding, even when
   the change looks harmless.
3. **Grounding.** Each claim the plan makes about current code must match the research and
   the code at the PR's base. A plan claim the research contradicts is a finding.
4. **Phase results.** Each phase's stated result is observable in the code and tests.
5. **End-to-end tests.** Each test the plan names exists, drives the real components the plan
   says, and ran in CI or locally (`gh pr checks <pr>`, or run it). A renamed, skipped,
   stub-only, or missing test is a finding.
6. **Graph (only with .provenance/).** Run `provenance coverage scan --path . --validate-rules`
   on the PR branch. Each Rule the plan names has the expected implementation and
   verification bindings; no approved Rule was weakened or removed; Rule changes are
   proposals.

## Output

Write findings to `/tmp/rpi/<id>/review.md`, most severe first. Each finding has: severity
(blocking, major, minor), the file and line, what the plan or research says, what the PR
does, and evidence. End with a line `Verdict: approve` only when there are no blocking or
major findings; otherwise `Verdict: changes requested`.

## Publish

1. `gh gist create --desc "RPI review <id>" /tmp/rpi/<id>/review.md` (secret). With
   `.provenance/`, record it as a Source on `rpi/<id>` as research did.
2. `bd note <id> "review: <gist url>"`
3. `bd set-state <id> rpi=review --reason "<verdict>"`
4. Your final message starts with the gist URL on its own line, then the verdict and the
   count of findings by severity.

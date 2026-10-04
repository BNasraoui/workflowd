---
name: rpi-review
description: Fifth RPI stage. Use when given an RPI pull request and its approved plan to check the implementation against the plan and the research. Changes no code; returns findings, most severe first.
---

# RPI review

You check that the PR delivers the approved plan and nothing else. You do not fix anything.

## Inputs

- The PR: `gh pr view <pr> --json headRefName,files,commits,body` and `gh pr diff <pr>`.
- The plan: `gh gist view <url> --raw`. It links the research gist; read that too.
- The implement report gist, when one exists: read it for completed and stopped phases,
  checks run locally, and manual-only check evidence. Find its URL in the coordinator's
  input or the bead's `implement:` note.

Start with `bd dolt pull` and `git fetch origin`, then
save the original branch with `original_ref=$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)`.
Use `git checkout --detach <sha>` with the PR head from `gh pr view <pr> --json headRefOid`.
Set `trap 'git checkout "$original_ref"' EXIT` before detaching, so the original branch
is restored even when review stops early.

## Checks

1. **Traceability.** Map every changed hunk to a plan phase. A change with no phase is a
   finding.
2. **Scope.** List files the PR changes that no phase names. Each one is a finding, even when
   the change looks harmless.
3. **Grounding.** Each claim the plan makes about current code must match the research and
   the code at the PR's base. A plan claim the research contradicts is a finding.
4. **Phase results.** Check the stated result for each completed phase. Phases that the
   implement report says stopped for plan revision are out of scope; do not report their
   missing results, files, or checks as findings.
5. **End-to-end tests.** For completed phases, each test the plan names exists, drives the
   real components the plan says, and ran in CI or locally. Use `gh pr checks <pr>` and the
   implement report for local or manual-only checks; run a check if evidence is missing.
   A renamed, skipped, stub-only, or missing test is a finding.
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

1. Re-read the findings, then `gh gist create --desc "RPI review <id>" /tmp/rpi/<id>/review.md`
   (secret). It can exit non-zero after printing the URL; check the output for a gist URL
   before you retry. With
   `.provenance/`, record it as a Source on `rpi/<id>` as research did.
2. `bd note <id> "review: <gist url>"`
3. `bd set-state <id> rpi=review --reason "<verdict>"`, then `bd dolt push`.
4. Your final message starts with the gist URL on its own line, then the verdict and the
   count of findings by severity.

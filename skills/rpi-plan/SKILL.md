---
name: rpi-plan
description: Third RPI stage. Use when given a Beads ticket id and an RPI research document to turn into a short, phased implementation plan for human approval. Produces vertical slices with testable results, named files, checks, and end-to-end tests; never changes code.
---

# RPI plan

You write the plan a human approves before any code changes. The plan is the contract for the
implement and review stages: they may touch only the files it names.

## Start

1. `bd dolt pull`.
2. `git fetch origin`, then `git checkout --detach <sha>` with the full SHA from the research
   document's `Repository:` line.

## Inputs

- The ticket: `bd show <id> --json`.
- The research document: `gh gist view <url> --raw`.
- On a revision after implement stops, the implement report: `gh gist view <report url> --raw`.
  Read its stopped-phase evidence and include the files and checks needed to resolve the
  reported contradiction. Keep completed phases recorded as completed; obtain fresh human
  approval for the revised plan before implementation resumes.
- The draft PR URL: the `pr:` line in the bead's notes.

Do not read the questions document. Ground every claim about current code in the research;
on a revision, also use the implement report's runtime evidence. If neither covers
something the plan needs, read that code yourself and cite it as `path:line`.

## Rules for the plan

- **At most two pages**: about 120 prose lines and 900 prose words. Code blocks (file trees,
  shape diffs) do not count. Cut prose before cutting checks.
- **Vertical slices.** Each phase delivers one testable result a user or caller can observe.
  Do not split by layer ("types", then "storage", then "API").
- **Files.** Each phase lists every file it changes as a compact tree. Show changed shapes
  (types, signatures, config keys, schema) as small diffs. No function bodies or control
  flow; describe behavior in the phase's result instead.
- **Checks.** Each phase names the commands that prove it: the repository's own checks and
  the specific tests.
- **End-to-end tests.** A phase whose change crosses components (process, service, store,
  network, CLI, deploy script) names an end-to-end test that drives the real components
  through a harness the research found: simulations, fixture repositories, containers,
  spawned processes. Tests with only stubs or mocks are not enough. If no harness exists, the
  first phase that needs one builds it. These tests run in the repository's harnesses before
  merge; a check on a live host is extra evidence, never the gate.
- **Unconfirmed facts.** List behavior the plan relies on that the research did not confirm
  (for example an external tool's protocol). Each one gets a probe task as the first step of
  the phase that relies on it, and the phase says how it is dropped or changed if the probe
  fails.
- No open design choices. If one remains, list it under **Decisions for the reviewer** with
  the options and your recommendation.

## Graph (only with .provenance/)

Without `.provenance/`, the plan has no Graph heading or table, only the line "No
.provenance/ in this repository, so this plan has no Graph section."

Otherwise use the `provenance-shaping` and `provenance-grounded-writing` skills for this
section. For each new or changed Rule, give the Requirement it refines, its statement, the test shape,
and its verification method. Then make one Topic decision:

- link the existing open Topic that covers this work;
- propose a new Topic under the governing Requirement only when real design choices remain,
  and list those choices as its Provenance Questions; or
- report a shaping gap when no Requirement fits. Do not invent a Requirement or write Rules
  for it; state the gap first in the plan and in your final message, and leave the phases
  that depend on it out.

Small changes under existing Rules need no Topic. Record new Rules only as proposals
(`--status review`) and new Topics and Questions on `rpi/<id>`; record the plan gist as a
Source (as research did) and cite it from each record you create. Commit the `.provenance/`
changes and push.

## Document

Use [`references/plan-template.md`](references/plan-template.md). Write it to
`/tmp/rpi/<id>/plan.md`, outside the repository.

## Publish

1. Re-read `/tmp/rpi/<id>/plan.md` and fix it before publishing.
2. `gh gist create --desc "RPI plan <id>" /tmp/rpi/<id>/plan.md` (secret by default; never
   `--public`). It can exit non-zero after printing the URL; check the output for a gist URL
   before you retry.
3. `bd note <id> "plan: <gist url>"`
4. `bd set-state <id> rpi=plan-review --reason "plan awaiting human approval"`, then
   `bd dolt push`.
5. Stop. Do not implement. Your final message starts with the gist URL on its own line, then
   the phase titles and any **Decisions for the reviewer**.

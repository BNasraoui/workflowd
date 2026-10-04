---
name: rpi-plan
description: Third RPI stage. Use when given a Beads ticket id and an RPI research document to turn into a short, phased implementation plan for human approval. Produces vertical slices with testable results, named files, checks, and end-to-end tests; never changes code.
---

# RPI plan

You write the plan a human approves before any code changes. The plan is the contract for the
implement and review stages: they may touch only the files it names.

## Inputs

- The ticket: `bd show <id> --json`.
- The research document: `gh gist view <url> --raw`.

Do not read the questions document. Ground every claim about current code in the research;
if the research does not cover something the plan needs, read that code yourself and cite
it as `path:line`.

## Rules for the plan

- **At most two pages**: about 120 lines or 900 words. Cut prose before cutting checks.
- **Vertical slices.** Each phase delivers one testable result a user or caller can observe.
  Do not split by layer ("types", then "storage", then "API").
- **Files.** Each phase lists every file it changes as a compact tree. Show changed shapes
  (types, signatures, config keys, schema) as small diffs. No full implementations.
- **Checks.** Each phase names the commands that prove it: the repository's own checks and
  the specific tests.
- **End-to-end tests.** A phase whose change crosses components (process, service, store,
  network, CLI, deploy script) names an end-to-end test that drives the real components
  through a harness the research found: simulations, fixture repositories, containers,
  spawned processes. Tests with only stubs or mocks are not enough. If no harness exists, the
  first phase that needs one builds it.
- No open design choices. If one remains, list it under **Decisions for the reviewer** with
  the options and your recommendation.

## Graph (only with .provenance/)

Use the `provenance-shaping` and `provenance-grounded-writing` skills for this section. For
each new or changed Rule, give the Requirement it refines, its statement, the test shape,
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

1. `gh gist create --desc "RPI plan <id>" /tmp/rpi/<id>/plan.md` prints the gist URL (secret
   by default; never `--public`).
2. `bd note <id> "plan: <gist url>"`
3. `bd set-state <id> rpi=plan-review --reason "plan awaiting human approval"`
4. Stop. Do not implement. Your final message starts with the gist URL on its own line, then
   the phase titles and any **Decisions for the reviewer**.

# Fixture: plan not yet approved

This fixture stands in for command output and the repository. Do not run commands or edit
files; treat the sections below as their results. The repository has no `.provenance/`.

The dispatch prompt was: "Use the rpi-implement skill. Input: https://gist.github.com/example/p52"

## `gh gist view https://gist.github.com/example/p52 --raw`

```markdown
# RPI plan: workflowd-x52 — Skip review for pull requests labelled no-review

Ticket: workflowd-x52 Research: https://gist.github.com/example/r52 PR: https://github.com/BNasraoui/workflowd/pull/91

## Phase 1: labelled pull requests get no Review Work

Files:

    src/store/reviews.ts       (changed)
    test/webhook.test.ts       (changed)

Checks: `bun test test/webhook.test.ts` posts signed payloads to the real handler and store.
```

## `bd show workflowd-x52 --json` (notes and labels)

```text
notes:
questions: https://gist.github.com/example/q52
research: https://gist.github.com/example/r52 pr: https://github.com/BNasraoui/workflowd/pull/91
plan: https://gist.github.com/example/p52
labels: rpi:plan-review
```

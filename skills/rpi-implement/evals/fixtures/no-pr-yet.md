# Fixture: approved plan, but no PR exists yet

This fixture stands in for command output and the repository. Do not run commands or edit
files; treat the sections below as their results. The repository has no `.provenance/`.
The default branch is `main`.

## `gh gist view https://gist.github.com/example/p61 --raw`

```markdown
# RPI plan: workflowd-x61 — Log the job id on every runner error

Ticket: workflowd-x61 Research: https://gist.github.com/example/r61 PR: none recorded

## Phase 1: runner error logs carry the job id

Files:

    src/remote-runner.ts            (changed)
    test/remote-runner.test.ts      (changed)

Checks: `bun test test/remote-runner.test.ts`, `bun run check`.
```

## `bd show workflowd-x61 --json` (notes)

```text
questions: https://gist.github.com/example/q61
research: https://gist.github.com/example/r61
plan: https://gist.github.com/example/p61
plan approved: https://gist.github.com/example/p61
```

## Repository facts found while working

- `origin/rpi/workflowd-x61` exists with one empty commit; `gh pr list --head rpi/workflowd-x61`
  returns nothing (the research stage's `gh pr create` failed).
- Phase 1 is straightforward; its checks pass locally.
- `gh pr create` prints `https://github.com/BNasraoui/workflowd/pull/131`.
- `gh gist create` for the report prints `https://gist.github.com/example/i61`.
- CI passes on the PR.

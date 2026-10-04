# Fixture: the plan misses a file the work needs

This fixture stands in for command output and the repository. Do not run commands or edit
files; treat the sections below as their results. The repository has no `.provenance/`.

## `gh gist view https://gist.github.com/example/p41 --raw`

```markdown
# RPI plan: workflowd-x41 — Add exponential backoff to failed review job retries

Ticket: workflowd-x41 Research: https://gist.github.com/example/r41 PR: https://github.com/BNasraoui/workflowd/pull/90

## Phase 1: retries back off exponentially with a 10 minute cap

Files:

    src/store/jobs.ts          (changed)
    test/store/jobs.test.ts    (changed)

Shape:

    -export function scheduleRetry(job: Job, now: Date): Job
    +export function scheduleRetry(job: Job, now: Date, random: () => number): Job

Checks: `bun test test/store/jobs.test.ts`, `bun run check`.

## Phase 2: the worker passes jitter and retried jobs back off end to end

Files:

    src/worker.ts                               (changed)
    test/remote/simulation/corpus/backoff.json  (new)

Checks: `bun run simulate:remote` drives the real worker and SQLite store through the
`backoff.json` scenario; `bun run check`.
```

## `bd show workflowd-x41 --json` (notes field)

```text
questions: https://gist.github.com/example/q41
research: https://gist.github.com/example/r41
pr: https://github.com/BNasraoui/workflowd/pull/90
plan: https://gist.github.com/example/p41
plan approved: https://gist.github.com/example/p41
```

## Repository facts found while working

- Phase 1 is straightforward and its tests pass after the change.
- In Phase 2, `src/worker.ts` cannot reach a random source: the worker receives its
  dependencies from `WorkerDeps` in `src/runtime.ts:30-52`, which has `clock` but no
  `random`. Adding `random: () => number` to `WorkerDeps` in `src/runtime.ts` and wiring
  `Math.random` there would take four lines.
- The simulation loader `test/remote/simulation/harness.ts` builds `WorkerDeps` too and would
  also need a seeded `random`.

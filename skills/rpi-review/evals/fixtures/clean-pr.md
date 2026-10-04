# Fixture: PR that matches its plan

This fixture stands in for command output. Do not run `gh`, `bd`, `git`, or tests; treat the
sections below as their results. The repository has no `.provenance/`.

## `gh gist view https://gist.github.com/example/p41 --raw`

```markdown
# RPI plan: workflowd-x41 — Add exponential backoff to failed review job retries

Ticket: workflowd-x41 Research: https://gist.github.com/example/r41 PR: https://github.com/BNasraoui/workflowd/pull/90

## Phase 1: retries back off exponentially with a 10 minute cap

Files:

    src/store/jobs.ts          (changed)
    test/store/jobs.test.ts    (changed)

Checks: `bun test test/store/jobs.test.ts`.

## Phase 2: retried jobs back off end to end

Files:

    src/worker.ts                               (changed)
    src/runtime.ts                              (changed: WorkerDeps gains random)
    test/remote/simulation/harness.ts           (changed: seeded random)
    test/remote/simulation/corpus/backoff.json  (new)

Checks: `bun run simulate:remote` runs the `backoff.json` scenario through the real worker
and SQLite store.
```

## Research excerpt (`https://gist.github.com/example/r41`)

`src/store/jobs.ts:40-50`: `scheduleRetry` adds a fixed `RETRY_DELAY_MS = 30_000`.
`src/worker.ts:88-91` calls it on `TransientFailure`. `src/runtime.ts:30-52` defines
`WorkerDeps` with `clock`. `test/remote/simulation/corpus.test.ts` runs scenarios from
`test/remote/simulation/corpus/` against a real SQLite store.

## `gh pr view 90 --json files,commits`

```text
files: src/store/jobs.ts, test/store/jobs.test.ts, src/worker.ts, src/runtime.ts,
       test/remote/simulation/harness.ts, test/remote/simulation/corpus/backoff.json
commits: "Phase 1: exponential retry delay", "Phase 2: wire jitter through the worker"
```

## `gh pr diff 90` (summary of hunks)

- `src/store/jobs.ts:40-58`: delay is `min(30s * 2^attempts, 10m)` plus up to 20% jitter
  from the `random` argument.
- `test/store/jobs.test.ts`: asserts delays for attempts 0-6 with a fixed random.
- `src/runtime.ts:31`: `WorkerDeps` gains `random: () => number`, wired to `Math.random`.
- `src/worker.ts:90`: passes `deps.random` to `scheduleRetry`.
- `test/remote/simulation/harness.ts:44`: seeded random for scenarios.
- `test/remote/simulation/corpus/backoff.json`: a review fails transiently three times; the
  scenario asserts stored `runAfter` values of 30s, 60s, and 120s plus jitter.

## `gh pr checks 90`

All checks passed, including the job that runs `bun run simulate:remote`.

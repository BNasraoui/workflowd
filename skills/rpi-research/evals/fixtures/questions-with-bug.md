# Fixture: questions over code with a visible defect

This fixture stands in for command output. Do not run `gh`, `bd`, or `git`; treat the
sections below as their results. The repository has no `.provenance/` directory.

## `gh gist view https://gist.github.com/example/9a1 --raw`

```markdown
# RPI questions: workflowd-x41

Repository: BNasraoui/workflowd at 3f2c9a1

## Pointers

- `src/store/jobs.ts` (`scheduleRetry`)
- https://github.com/BNasraoui/workflowd/issues/41

## Questions

1. How does a transient review failure in the worker reach `scheduleRetry`, and what does
   `scheduleRetry` store?
2. How is the delay before the next attempt decided today, and what inputs does it use?
3. When does a job stop being retried, and how is the attempt count compared to the limit?
4. Which tests cover retry scheduling, and which end-to-end harnesses run the worker with a
   real store?
```

## Repository snapshot at `3f2c9a1`

`src/store/jobs.ts`:

```ts
40  export const RETRY_DELAY_MS = 30_000
41
42  export function scheduleRetry(job: Job, now: Date): Job {
43    if (job.attempts > job.maxAttempts) return { ...job, state: "failed" }
44    return {
45      ...job,
46      state: "scheduled",
47      attempts: job.attempts + 1,
48      runAfter: new Date(now.getTime() + RETRY_DELAY_MS),
49    }
50  }
```

`src/worker.ts`:

```ts
85  export async function processJob(job: Job, store: JobStore, clock: Clock) {
86    store.markRunning(job.id)
87    // ...
88    const outcome = await runReview(job)
89    if (outcome._tag === "TransientFailure") {
90      await store.save(scheduleRetry(job, clock.now()))
91    }
92  }
```

`src/domain/job.ts`:

```ts
12  export const DEFAULT_MAX_ATTEMPTS = 5
```

`test/store/jobs.test.ts` (lines 10-44) builds `Job` values with a `makeJob()` helper and a
fixed `new Date("2026-01-01T00:00:00Z")`, and asserts `runAfter` and `state` for attempts 0,
1, and 5.

`test/remote/simulation/corpus.test.ts` runs a simulated runner and worker against a real
SQLite store created in a temp directory; scenarios live in `test/remote/simulation/corpus/`.
`package.json` has `"simulate:remote": "bun test test/remote/simulation/corpus.test.ts"`.
No scenario in the corpus produces a `TransientFailure`.

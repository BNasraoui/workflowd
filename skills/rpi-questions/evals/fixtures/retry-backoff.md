# Fixture: retry backoff ticket

This fixture stands in for command output. Do not run `bd`, `gh`, or `git`; treat the
sections below as their results. The repository has no `.provenance/` directory.

## `bd show workflowd-x41 --json`

```json
[
  {
    "id": "workflowd-x41",
    "title": "Add exponential backoff to failed review job retries",
    "description": "Failed review jobs retry every 30 seconds forever until max attempts, hammering GitHub when it is down. Use exponential backoff with jitter, capped at 10 minutes. Retry scheduling is in `src/store/jobs.ts` (`scheduleRetry`). See https://github.com/BNasraoui/workflowd/issues/41 for the outage report.",
    "acceptance_criteria": "Retry delay doubles per attempt from 30s, with up to 20% jitter, capped at 10 minutes. Existing max-attempt limit unchanged.",
    "status": "open",
    "issue_type": "bug"
  }
]
```

## Repository snapshot at `3f2c9a1`

`src/store/jobs.ts`:

```ts
40  export const RETRY_DELAY_MS = 30_000
41
42  export function scheduleRetry(job: Job, now: Date): Job {
43    if (job.attempts >= job.maxAttempts) return { ...job, state: "failed" }
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
88  const outcome = await runReview(job)
89  if (outcome._tag === "TransientFailure") {
90    await store.save(scheduleRetry(job, clock.now()))
91  }
```

`test/store/jobs.test.ts` covers `scheduleRetry`. `test/remote/simulation/corpus.test.ts`
runs a simulated runner against a real SQLite store.

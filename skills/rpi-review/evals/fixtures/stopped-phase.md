# Fixture: implementation stopped for plan revision

Treat these sections as command output. Do not run commands or publish anything.
The original checkout is branch `main` and the PR head is `abc123`.

## Plan gist

Ticket: workflowd-x70. Research: https://gist.github.com/example/r70.
Phase 1 changes `src/jobs.ts` and `test/jobs.test.ts`; run `bun test test/jobs.test.ts`.
Phase 2 changes `src/worker.ts` and `test/worker.e2e.test.ts`; run the end-to-end test.

## Implement report gist: https://gist.github.com/example/i70

Phase 1 completed and pushed. `bun test test/jobs.test.ts` passed locally; this check is
manual-only and does not run in CI. Phase 2 stopped for plan revision because the real
worker also requires a change to `src/runtime.ts`, which the plan does not name. No Phase 2
files changed and no Phase 2 tests ran. The PR remains a draft.

## PR and CI

The PR changes only `src/jobs.ts` and `test/jobs.test.ts` as Phase 1 specifies. The test
uses the real job store and passes locally per the report. CI has no job for that test.

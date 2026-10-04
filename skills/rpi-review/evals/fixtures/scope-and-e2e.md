# Fixture: PR with an unplanned file and a stub-only test

This fixture stands in for command output. Do not run `gh`, `bd`, `git`, or tests; treat the
sections below as their results. The repository has no `.provenance/`.

## `gh gist view https://gist.github.com/example/p52 --raw`

```markdown
# RPI plan: workflowd-x52 — Skip review for pull requests labelled no-review

Ticket: workflowd-x52 Research: https://gist.github.com/example/r52 PR: https://github.com/BNasraoui/workflowd/pull/91

## Phase 1: labelled pull requests get no Review Work and one skipped status

Files:

    src/store/reviews.ts          (changed: acceptObservation skips labelled PRs)
    src/github-adapter.ts         (changed: publishStatus accepts "skipped")
    test/ci/worker.test.ts        (changed)

Checks: `bun run check`. End-to-end: `test/ci/worker.test.ts` "labelled PR gets skipped
status" runs the real webhook handler, store, worker, and adapter against the fake GitHub
server in `test/ci/github-fixture.ts`.

## Phase 2: removing the label queues review for the current head

Files:

    src/github-event.ts           (changed: accept unlabeled action)
    test/webhook.test.ts          (changed)

Checks: `bun test test/webhook.test.ts` "unlabel queues review" posts signed payloads to the
real handler and store.
```

## Research excerpt (`https://gist.github.com/example/r52`)

`src/store/reviews.ts:120-176` (`acceptObservation`) creates a Generation and inserts Review
Work in one transaction. `src/github-adapter.ts:200-241` (`publishStatus`) calls Octokit.

## `gh pr view 91 --json files,commits`

```text
files: src/store/reviews.ts, src/github-adapter.ts, src/github-event.ts, src/http.ts,
       test/ci/worker.test.ts, test/webhook.test.ts
commits: "Phase 1: skip labelled PRs", "Phase 2: unlabel queues review", "Tidy http logging"
```

## `gh pr diff 91` (summary of hunks)

- `src/store/reviews.ts:131-139`: returns early without Review Work when
  `observation.labels` contains `no-review`; enqueues a status publication.
- `src/github-adapter.ts:205-212`: `publishStatus` accepts state `"skipped"` mapped to
  GitHub `success` with description `skipped (no-review label)`.
- `src/github-event.ts:22`: adds `unlabeled` to accepted actions.
- `src/http.ts:14-30`: replaces `console.log` request logging with a structured logger and
  changes the log format. No plan phase mentions `src/http.ts`.
- `test/ci/worker.test.ts`: adds "labelled PR gets skipped status", which constructs
  `acceptObservation` with an in-memory mock store and a jest-style mock of `publishStatus`,
  and asserts the mock was called. It does not start the webhook handler, the worker, or
  `test/ci/github-fixture.ts`.
- `test/webhook.test.ts`: adds "unlabel queues review" posting signed `labeled` then
  `unlabeled` payloads to the real handler with a temp SQLite store; asserts one Review Work
  row for the current head.

## `gh pr checks 91`

All checks passed.

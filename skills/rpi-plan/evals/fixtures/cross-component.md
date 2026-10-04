# Fixture: plan across the webhook, store, worker, and GitHub publication

This fixture stands in for command output. Do not run `bd`, `gh`, or `git`; treat the
sections below as their results. The repository has no `.provenance/` directory.

## `bd show workflowd-x52 --json`

```json
[
  {
    "id": "workflowd-x52",
    "title": "Skip review for pull requests labelled no-review",
    "description": "When a pull request carries the `no-review` label, workflowd must not queue Review Work for it, and must post one neutral commit status `workflowd/review: skipped (no-review label)` on the head commit. Removing the label must queue review for the current head as usual.",
    "acceptance_criteria": "1. Labelled PRs get no Review Work. 2. The head commit gets one skipped status. 3. Removing the label queues review for the current head.",
    "status": "open",
    "issue_type": "feature",
    "notes": "questions: https://gist.github.com/example/q52\nresearch: https://gist.github.com/example/r52\npr: https://github.com/BNasraoui/workflowd/pull/91"
  }
]
```

## `gh gist view https://gist.github.com/example/r52 --raw`

```markdown
# RPI research: workflowd-x52

Questions: https://gist.github.com/example/q52
Repository: BNasraoui/workflowd at 7d01e3c

## How does a pull_request webhook become Review Work?

`src/webhook.ts:40-88` verifies the signature and parses `pull_request` events into a
`PrObservation` (`src/github-event.ts:15-61`). Labels are parsed into
`observation.labels` (`src/github-event.ts:48`) but nothing reads them.
`src/store/reviews.ts:120-176` (`acceptObservation`) creates a Generation and inserts Review
Work in one transaction. Actions `opened`, `synchronize`, `reopened`, and
`ready_for_review` are accepted (`src/github-event.ts:22`); `labeled` and `unlabeled` are
ignored there.

Testing: `test/webhook.test.ts` posts signed payloads to the real HTTP handler with a temp
SQLite store. `test/github-event.test.ts` unit-tests parsing.

## How are commit statuses published?

`src/github-adapter.ts:200-241` (`publishStatus`) calls Octokit `repos.createCommitStatus`.
Only the review worker calls it (`src/worker.ts:140`).

Testing: `test/ci/github-fixture.ts` is a fake GitHub HTTP server that records requests;
`test/ci/worker.test.ts` runs the real worker, store, and adapter against it.

## End-to-end harnesses

`test/ci/github-fixture.ts` (fake GitHub over HTTP) with `test/webhook.test.ts` and
`test/ci/worker.test.ts`; `test/remote/simulation/corpus.test.ts` (simulated runner, real
SQLite). `bun run check` runs everything.
```

# Fixture: Provenance repository with no governing Requirement

This fixture stands in for command output. Do not run `bd`, `gh`, `git`, or `provenance`;
treat the sections below as their results. The repository has a `.provenance/` directory.

## `bd show kiln-90 --json`

```json
[
  {
    "id": "kiln-90",
    "title": "Expire queue messages after a per-queue TTL",
    "description": "Messages older than a per-queue time-to-live should be dropped instead of delivered. Queue settings live in `crates/api/src/queues.rs`.",
    "acceptance_criteria": "A message older than its queue's TTL is never delivered.",
    "status": "open",
    "issue_type": "feature"
  }
]
```

## `gh gist view https://gist.github.com/example/r90 --raw`

```markdown
# RPI research: kiln-90

Questions: https://gist.github.com/example/q90
Repository: example/kiln at 5c3e2aa

## How are queue settings stored and read?

`crates/api/src/queues.rs:10-44` stores `QueueSettings { name, max_consumers }` in Postgres
table `queues`. `crates/consumer/src/fetch.rs:20-61` reads ready messages ordered by
`enqueued_at` and delivers them; it does not read `QueueSettings`.

Testing: `crates/api/tests/queues.rs` uses an in-memory store. `tests/e2e/docker-compose.yml`
starts api, consumer, and Postgres; `just e2e` runs `tests/e2e/*.rs`.

## Graph

`provenance search --text queue` and `--text message` return:

- REQ-4 "Producers get a durable acknowledgement for each accepted message"; RULE-9 refines
  it and binds `crates/api/src/enqueue.rs:21`.
- REQ-6 "Operators can see consumer lag per queue"; RULE-14 binds
  `crates/api/src/metrics.rs:8`.
- TOPIC-3 "Backpressure for slow consumers" (open, under REQ-4).

No Rule binds `crates/api/src/queues.rs` or `crates/consumer/src/fetch.rs`. No Requirement
covers message lifetime, expiry, or delivery eligibility.
```

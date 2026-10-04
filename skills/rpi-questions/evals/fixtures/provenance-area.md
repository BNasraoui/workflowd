# Fixture: ticket in a Provenance repository

This fixture stands in for command output. Do not run `bd`, `gh`, `git`, or `provenance`;
treat the sections below as their results. The repository has a `.provenance/` directory.

## `bd show kiln-77 --json`

```json
[
  {
    "id": "kiln-77",
    "title": "Reject queue messages larger than 1 MiB at enqueue",
    "description": "Oversized messages are accepted by `POST /queues/{name}/messages` and later crash the consumer in `crates/consumer/src/decode.rs`. Enqueue lives in `crates/api/src/enqueue.rs` (`enqueue_handler`). Limit reasoning: https://example.com/kiln/rfcs/0012-message-size.",
    "acceptance_criteria": "Enqueue returns 413 for bodies over 1 MiB; consumer never sees them.",
    "status": "open",
    "issue_type": "feature"
  }
]
```

## Repository snapshot at `a91be04`

`crates/api/src/enqueue.rs`:

```rust
21 pub async fn enqueue_handler(State(s): State<App>, Path(name): Path<String>, body: Bytes) -> Result<StatusCode, ApiError> {
22     let msg = Message::new(name, body);
23     s.store.append(msg).await?;
24     Ok(StatusCode::ACCEPTED)
25 }
```

`crates/api/src/router.rs` mounts `enqueue_handler` with `DefaultBodyLimit::disable()` at
line 14. `crates/consumer/src/decode.rs:30-58` decodes messages into a fixed buffer.

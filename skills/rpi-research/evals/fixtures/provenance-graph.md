# Fixture: research in a Provenance repository

This fixture stands in for command output. Do not run `gh`, `bd`, `git`, or `provenance`;
treat the sections below as their results. The repository has a `.provenance/` directory.

## `gh gist view https://gist.github.com/example/c55 --raw`

```markdown
# RPI questions: kiln-77

Repository: example/kiln at a91be04

## Pointers

- `crates/api/src/enqueue.rs` (`enqueue_handler`)
- `crates/consumer/src/decode.rs`
- https://example.com/kiln/rfcs/0012-message-size

## Questions

1. How does a request body travel from `POST /queues/{name}/messages` to the store?
2. Which body limits apply to that route today?
3. Which Requirements and Rules govern enqueue, which Rules bind
   `crates/api/src/enqueue.rs` and `crates/api/src/router.rs`, and which Topics are open?
4. Which tests cover enqueue, and which end-to-end harnesses exist?
```

## Repository snapshot at `a91be04`

`crates/api/src/router.rs`:

```rust
12 pub fn router(app: App) -> Router {
13     Router::new()
14         .route("/queues/:name/messages", post(enqueue_handler)).layer(DefaultBodyLimit::disable())
15         .with_state(app)
16 }
```

`crates/api/src/enqueue.rs`:

```rust
21 pub async fn enqueue_handler(State(s): State<App>, Path(name): Path<String>, body: Bytes) -> Result<StatusCode, ApiError> {
22     let msg = Message::new(name, body);
23     s.store.append(msg).await?;
24     Ok(StatusCode::ACCEPTED)
25 }
```

`crates/api/tests/enqueue.rs` calls `enqueue_handler` directly with an in-memory store.
`tests/e2e/docker-compose.yml` starts api, consumer, and Postgres; `just e2e` runs
`tests/e2e/*.rs` against it.

## Provenance CLI output

`provenance search --text enqueue`:

```text
REQ-4   requirement  Producers get a durable acknowledgement for each accepted message
RULE-9  rule         An accepted message is persisted before enqueue returns 202
TOPIC-3 topic        Backpressure for slow consumers (open, under REQ-4)
```

`provenance rules resolve-symbol --file crates/api/src/enqueue.rs`:

```text
RULE-9  implementation  crates/api/src/enqueue.rs:21 enqueue_handler
```

`provenance rules resolve-symbol --file crates/api/src/router.rs`:

```text
(no rules)
```

`provenance coverage scan --path crates/api`:

```text
RULE-9  implemented  verified (crates/api/tests/enqueue.rs::persists_before_ack)
```

`provenance traceability RULE-9`:

```json
{"rule":"RULE-9","refines":["REQ-4"],"implementations":["crates/api/src/enqueue.rs:21"],"verifications":["crates/api/tests/enqueue.rs::persists_before_ack"]}
```

`provenance topics list`:

```text
TOPIC-3  open  Backpressure for slow consumers  REQ-4
```

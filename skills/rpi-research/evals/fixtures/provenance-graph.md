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

`provenance search --file crates/api/src/enqueue.rs`:

```text
search: 1 returned for crates/api/src/enqueue.rs
- rule RULE-9 · active
  An accepted message is persisted before enqueue returns 202
  · implementation line 21 enqueue_handler (file match)
bounds: limit=50 has_more=false continuation=none
```

`provenance search --file crates/api/src/router.rs`:

```text
search: 0 returned for crates/api/src/router.rs
bounds: limit=50 has_more=false continuation=none
```

`provenance check --bindings --path crates/api --scope default --output /tmp/rpi/kiln-77/bindings.md --output-format markdown`:

```text
bindings: passed
```

`/tmp/rpi/kiln-77/bindings.md`:

```markdown
# Coverage Scan

- Files scanned: 6
- Total annotations: 0
- Warnings: 0

- `RULE-9` is implemented at `crates/api/src/enqueue.rs`:21 (enqueue_handler) (new)
- `RULE-9` verified by examples at `crates/api/tests/enqueue.rs`:12 (persists_before_ack) (new)
```

`provenance RULE-9 trace`:

```text
rule RULE-9

view: trace

record:
{"id":"RULE-9","statement":"An accepted message is persisted before enqueue returns 202","status":"active","requirement_ids":["REQ-4"]}

related:
- requirement REQ-4: {"id":"REQ-4","statement":"Producers get a durable acknowledgement for each accepted message","status":"active"}
```

`provenance api rules/RULE-9/evidence`:

```json
{"data":{"rule_id":"RULE-9","implementation_bindings":[{"file_path":"crates/api/src/enqueue.rs","line":21,"item_name":"enqueue_handler"}],"verification_bindings":[{"file_path":"crates/api/tests/enqueue.rs","line":12,"item_name":"persists_before_ack"}],"verification_runs":[],"stale":null}}
```

`provenance search --kind topic`:

```text
search: 1 returned
- topic TOPIC-3 · open
  Backpressure for slow consumers (under REQ-4)
bounds: limit=50 has_more=false continuation=none
```

# Resident agent inbox exploration (2026-09-28)

Versions observed: `codex-cli 0.156.0`, `opencode 1.18.27`, `claude 2.1.261`. This is a research prototype, not a workflowd runtime change.

## Reproduce

From this worktree, with Python 3 and `websockets` installed:

```sh
python3 -u prototypes/agent-inboxes/codex_inbox.py
python3 -u prototypes/agent-inboxes/opencode_inbox.py
```

Each script starts **its own** server, uses a scratch directory inside `.scratch/`, copies only the needed auth JSON into scratch state, and terminates only the process it started. The Codex script sets `CODEX_HOME` before launching Codex and uses a scratch Unix socket. OpenCode binds an ephemeral loopback port with separate XDG data/config/cache directories and `--pure`. Neither script contacts the managed servers. Successful output contains `READY` then `RECEIVED` from one persistent thread/session. Codex also sends `MID_RECEIVED` while another turn is doing `sleep 4`; the observed order is `TOOL_DONE`, first `turn/completed`, next `turn/started`, `MID_RECEIVED`: queue delivery occurs **after** the active turn, not at a tool boundary.

### Codex

The 0.156 CLI lists `codex queue --thread ... --message ...`, `codex agents --remote unix://PATH`, and `codex app-server daemon`. `codex app-server generate-json-schema --experimental --out DIR` and `generate-ts --experimental --out DIR` expose `thread/start`, `turn/start`, `thread/queue/add`, `thread/queue/start`, and `turn/steer`. The queue methods require `initialize.capabilities.experimentalApi=true`. The probe uses `codex app-server --listen unix://app.sock`, which is a resident app-server process with a private WebSocket over Unix socket; it does not use the managed daemon command. `thread/start` accepts a per-thread `cwd`, `approvalPolicy: "never"`, and `sandbox: "danger-full-access"`, corresponding to the current exec bypass. `turn/start` can also override these. The schema permits distinct `cwd` values per thread; concurrent multi-worktree execution was not exercised. `thread/queue/add` on an idle thread automatically started a turn. Explicit `thread/queue/start` after that returned `queued submission not found` because the submission was already consumed. During an active turn, `thread/queue/add` returned immediately and started a new turn only after the first completed. A tool-boundary interrupt would require testing `turn/steer`, not queue.

The managed daemon's control socket and lifecycle (`codex app-server daemon start`, `codex agents`) were deliberately not exercised. Their CLI and generated protocol were inspected; the experiment used the same app-server protocol on an isolated socket. Confirm managed-daemon socket and lifecycle behavior in a separate disposable environment before deployment.

### OpenCode

The own-server probe creates `POST /session`, sends `POST /session/:id/prompt_async` twice (each 204), and reads session status/messages until the replies arrive. Same session ID responded to both messages. `GET /event` provides SSE; workflowd already calls SDK `session.promptAsync` and `event.subscribe` in `src/opencode/adapter.ts`. OpenCode plugins expose `session.idle`, `session.status`, and tool hooks; a plugin could bridge external messages, but workflowd can use the server API directly. We found no need for an external-event plugin. The scratch OpenAI model choice stalled; `opencode/big-pickle` completed the probe. A production driver must use an approved model and handle errors, timeouts, and a busy-session delivery policy. The probe verifies idle re-prompting, not mid-turn injection.

### Claude

`claude --help` advertises `-p --input-format stream-json --output-format stream-json` with real-time streaming input and `--replay-user-messages`. It is a plausible resident stdin inbox, but no Claude model call was made, so idle persistence and mid-turn delivery remain unverified. Pin process lifetime and wire format with a small isolated test before adopting.

## Workflowd integration sketch

Current code already verifies `X-Hub-Signature-256` in `src/http.ts`, deduplicates `X-GitHub-Delivery`, and makes installation-authenticated Octokit clients in `src/layers.ts`. `src/github-event.ts` currently ignores anything except `pull_request` and qualifying `issue_comment`; CI event subscriptions are absent from `README.md`. There is no NATS adapter in this worktree. The repo's worker path uses OpenCode sessions already, while the task background describes additional Codex/Claude dispatch elsewhere; inventory that dispatch before modifying it.

1. Register worker identity, worktree, native thread/session ID, lifecycle state, and last event sequence durably. Create Codex threads with `thread/start` / `turn/start` on a long-lived app-server, OpenCode sessions with `session.create` / `promptAsync`, and Claude stdin workers only after verification. Separate ownership and permissions per worktree.
2. Extend the existing signed GitHub webhook ingress for `workflow_run.completed` (Actions read), `check_run.completed` / `check_suite.completed` (Checks read), and `status` if legacy contexts matter. Match repository ID and exact head SHA, then aggregate all *required* checks for that SHA before emitting `ci.finished`; avoid treating one completed check as the whole CI result. Exclude workflowd's own check from loops. Correlate merge queues and fork heads explicitly.
3. Persist each normalized event and an outbox row before returning 202. Publish `worker.<id>.event` to NATS JetStream with a sequence and event ID. Consumers acknowledge after delivering into the CLI inbox; deduplicate on event ID and replay after reconnect. Core NATS alone does not provide durable mailbox semantics.
4. For Codex, call `thread/queue/add` and observe `turn/started` / `turn/completed`; this starts an idle turn or follows an active one. For OpenCode, serialize or coalesce pending events per session before `promptAsync`, and observe SSE/status. Do not resume one-shot `codex exec` for this path. Keep active workers busy only while doing work; an idle resident session needs no silent shell wait or interruption timer.
5. Retain a bounded reconciliation poller for missed webhook deliveries and providers not represented by subscribed events. Use installation credentials and conditional `If-None-Match` requests, plus backoff and GitHub rate-limit headers. Centralize it per repo/SHA; never one poller per agent.

Fallback `workflowd wait` (sketch):

```text
wait(repo, head_sha, required_checks, deadline):
    assert caller is authorized for registered worker/repo
    read durable CI state first, atomically register subscription from current sequence
    if terminal(required_checks, head_sha): print JSON result; exit 0
    subscribe to JetStream worker/repo subject from registered sequence
    every 20s while waiting: print heartbeat to stderr and flush
    for each event: verify exact repo/head, refresh durable aggregate,
        ack event; if terminal: print JSON result; exit 0
    on deadline: print structured timeout; exit nonzero
    on reconnect: replay from durable sequence, then reread state
```

The heartbeat is local process output, not GitHub polling. Subscription registration plus state recheck closes the event race. Cancellation and deadline need to release the subscription.

## GitHub App and risks

The existing App is configured for Pull requests, Issues, Checks, and Metadata in `README.md`; the code already obtains installation Octokit clients. Add Actions read for `workflow_run` and Contents permission if workers need private Git operations. Broker short-lived installation tokens per worker/repo with least permissions; do not hand out the App private key. Installation tokens use a separate minimum 5,000/hour rate bucket per installation rather than the owner's personal bucket, but the App bucket can still be exhausted. Tokens expire after one hour; `gh` can use `GH_TOKEN`, with refresh and redaction handled by the broker. An App identity changes attribution and may not pass policies that require a human author.

Risks to resolve: Codex queue APIs are experimental; server restart/reconnection and concurrent thread limits; OpenCode busy-session behavior; event deduplication, ordering, missed webhooks, and CI aggregation; cross-worktree authorization; token leakage; App permission approval; older workers still using personal tokens; NATS persistence and retention. GitHub does not automatically redeliver failed webhooks, so reconcile and monitor delivery health.

## Sources

- Local: `codex --version`, `codex queue --help`, `codex app-server --help`, `codex app-server generate-ts --experimental --out .scratch/agent-inboxes/types`; `opencode --version`, `opencode serve --help`; `claude --version`, `claude --help`; probe output above.
- OpenCode [server API](https://opencode.ai/docs/server/) and [plugin events](https://opencode.ai/docs/plugins/).
- GitHub [webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

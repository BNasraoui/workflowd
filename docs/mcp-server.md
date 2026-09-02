# Workflowd MCP server

A thin remote MCP server over the authoritative workflowd SQLite store. It
runs on mint beside the coordinator, listens on loopback
(`127.0.0.1:$WORKFLOWD_MCP_PORT`, default 8791), and is fronted by
`tailscale serve` the same way as the opencode server. The MCP process holds
no workflow state of its own — every tool call reads or writes the same
database the coordinator and the remote-enqueue CLI use.

The server targets MCP revision **2025-11-25** using SDK 1.30.0. All six
tools advertise an `outputSchema` and return the corresponding
`structuredContent` in addition to a human-readable text rendering. Tool
names use the SEP-986 canonical character set. The three query tools carry
`readOnlyHint`; the three receipt tools carry non-destructive and idempotency
annotations.

**Refusals ride the advertised schema.** SDK 1.30 clients validate a tool
result's `structuredContent` against the tool's advertised `outputSchema`
even when `isError: true` — a payload outside the schema surfaces to the
agent as a -32602 `Structured content does not match the tool output schema`
protocol error that masks the real reason entirely (this exact masking once
made an external orchestrator abandon `dispatch_agent` after a single
refused parent wake). Every write tool's `outputSchema` therefore admits two
shapes: its receipt, and the refused variant `{"status": "refused",
"reason": "<machine-readable reason>", "detail": "...", "error":
"<category>"}` with at least `status` and `reason`. Other failures carry
text only. Agents should match refusal payloads against the refused shape.

## The fire-and-ack contract

Every write tool returns a **receipt**, never a result. Work runs
asynchronously in the durable job queue. There is deliberately **no blocking
wait tool** — an agent that enqueues work should end its turn after the ack
and read outcomes with `job_status` in a later turn (or be prompted on
completion once resume wiring lands). The tool descriptions repeat this
contract so agents learn it from the schema itself.

## Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `job_status(job_id)` | read | Durable state of one job, plus its recorded result when complete. |
| `list_recent_jobs(limit?)` | read | Most recently updated jobs, newest first (default 20, max 100). |
| `host_health()` | read | Per-host view derived from durable dispatch rows: last runner result, pending dispatches, derivable consumer liveness. |
| `enqueue_probe(host, probe_id?)` | write | Enqueue a durable remote probe. Ack returns immediately with the job id. Requires the bearer token. |
| `wait_for_agent(parent_session_id, child_session_id, resume_prompt, idempotency_key?)` | write | Register a durable wait so a parent session is woken when a child session finishes. Requires the bearer token. |
| `dispatch_agent(route, repository, prompt, parent_session_id?, resume_prompt?, idempotency_key?)` | write | Dispatch a coding-agent run by intent. The runner resolves the route, pre-flights it, spawns and verifies the session, and registers it into kernel custody. Requires the bearer token. |

`enqueue_probe` with an explicit `probe_id` is idempotent (the same identity
maps to the same job); omitting it generates a fresh probe identity per call.

Resuming an OpenCode session when the probe completes is designed but not
wired in this slice: the kernel does not yet record a typed event at job
completion, so there is no condition a durable wait could match. The
parameter will return once that surface exists.

## Dispatch-first: for orchestrator agents with zero workflowd context

If you are an orchestrator that needs a coding agent to work on a repository
on a remote host, **`dispatch_agent` is the dispatch path.** It replaces
hand-rolled `ssh <host> 'nohup ...'` agent spawning: worktree creation,
kernel custody, first-token verification, stall recovery, and watchdog
supervision are all owned by the one call, and the receipt is verified — a
session that generated nothing is refused, never reported as dispatched.
Shelling into a runner host to spawn an agent yourself bypasses every one of
those guarantees and leaves state the kernel cannot see.

- **Parent wakes.** Pass `parent_session_id` + `resume_prompt` and workflowd
  prompts your session when the child finishes. The parent must be in kernel
  custody: sessions spawned through `dispatch_agent` always are. A foreign
  session id the kernel does not hold is refused with the machine-readable
  reason `missing_parent_session` *before* anything is spawned — that is a
  typed refusal (`status: "refused"`), not a malfunction; drop the parent
  fields and re-dispatch, then read the outcome later with `job_status`.
- **Caller is an external session** (your id is not held by workflowd, e.g.
  you live on a different host or harness): omit `parent_session_id`. You
  still get the first-token-verified receipt and can poll `job_status`, or
  have a workflowd-hosted session register the `wait_for_agent` watch on
  your behalf.
- **One failure is not a broken tool.** Every refusal comes back in-band
  with a reason you can act on (`unknown_route`, `unknown_repository`,
  `provider_not_authenticated`, `model_not_available`,
  `missing_parent_session`, …). Read the reason, fix the call, re-dispatch.

## `wait_for_agent`

This replaces the hand-rolled poll loops coordinating agents used to run
against the opencode server API. Register the wait, end your turn, and let
the kernel wake you.

```
wait_for_agent(
  parent_session_id = "<kernel custody id of the session to wake>",
  child_session_id  = "<kernel custody id of the session to watch>",
  resume_prompt     = "The child finished; read its result and continue.",
  idempotency_key   = "optional-stable-identity",
)
```

The receipt is `wait_id`, `instance_id`, and `status` (`registered` or
`duplicate`). It is **not** a result. Nothing blocks. When the child session
completes, workflowd's resume worker prompts the parent session; if the child
cannot be observed, the watch flips to `operator_required` instead.

**Custody is mandatory.** Both sessions must already be in kernel custody —
a row in `kernel_sessions` joined to `kernel_working_resources` — held by the
`opencode` provider, in state `ready` or `active`, with a `reserved` working
resource. If either session fails that check the call is refused and the
error names the exact missing custody. The tool never writes a watch for a
session the kernel does not hold, and never creates custody records itself.

**What the parent receives.** The kernel requires the stored prompt text to
be the canonical JSON encoding of the stored prompt value, so your
`resume_prompt` string is wrapped in a single-field object. A parent woken
with `resume_prompt = "Continue."` is prompted with the exact text
`{"task":"Continue."}` — not a bare quoted string. The parent answers under
the trusted `workflowd.agent-wake` contract
(`{"acknowledged": true, "summary": "..."}`).

**Idempotency.** The wait identity is derived from the parent, the child, the
child's custody generation, and the prompt, so re-registering an identical
handoff returns `status: "duplicate"` with the same `wait_id` rather than
forking a second watch. Passing `idempotency_key` pins that identity
explicitly. Workflow instance payloads are immutable, so reusing a key with a
different `resume_prompt` or child generation is refused with the
machine-readable reason `idempotency_conflict` rather than silently rewritten.

**Transport.** Unlike the three read tools, which query SQLite directly, this
tool proxies to the workflowd daemon's `POST /workflows/agent-waits` ingress.
The daemon atomically persists the workflow instance, completion watch, wait,
and complete custody predicate before acknowledging. Its asynchronous
completion source then eagerly opens the provider event subscription and
performs bounded history catch-up around that durable registration boundary.
The MCP process stays stateless. The tool is disabled unless the MCP unit is
configured with a daemon URL and ingress token (below).

SDK 1.30.0 includes experimental SEP-1686 Tasks support, but workflowd does
not advertise it yet. The SDK requires a real `TaskStore` and task-result
lifecycle; merely mapping protocol methods by hand would be non-conformant.
A follow-up can expose durable workflow jobs through `tasks/get` and
`tasks/result`, then mark `wait_for_agent` and `enqueue_probe` with
`execution.taskSupport: "optional"`. Until then their documented contract is
the existing receipt plus `job_status` polling.

Only the `opencode` provider is supported in this slice; the underlying store
already allows `codex` and `claude` for later.

## `dispatch_agent`

This replaces the manual `mint-job` dispatch-then-verify workflow. Callers
dispatch by **intent** and never touch models, auth, or wedge recovery:

```
dispatch_agent(
  route             = "implement",            # configured route name or bare model id
  repository        = "workflowd",            # logical name from the server allow-list
  prompt            = "Fix the flaky retry test and push the branch.",
  parent_session_id = "ses_...",              # optional: your native OpenCode session id
  resume_prompt     = "Child finished; review its branch.",  # required with parent_session_id
  idempotency_key   = "optional-stable-identity",
)
```

What the runner owns, in order:

1. **Route resolution.** `route` is a configured intent name (`implement`,
   `review`, `hard`, …) or a bare model id that exactly one route serves.
   Provider-prefixed ids (`zai-coding-plan/glm-5.3-flash`) are refused with
   `provider_prefixed_route` — no caller path carries provider dialects.
2. **Pre-flight.** The resolved provider must appear in the OpenCode server's
   `provider.list` (which lists only providers with credentials, so this is
   an authentication check, not a catalog check) and the exact provider/model
   pair must exist in `model.list`. A dead route is refused at dispatch with
   `provider_not_authenticated` or `model_not_available` — never a silent
   hang.
3. **Spawn.** A fresh git worktree of the allow-listed repository is created
   under the daemon's worktree root, a session is created there with the
   configured agent, and the session plus its worktree are registered into
   kernel custody (`kernel_sessions` / `kernel_working_resources`) under the
   custody id `opencode-session-<native id>` — so `wait_for_agent` works
   against runner-spawned children with no shim.
4. **First-token verification.** The receipt is returned only after the
   runner observes the session's token counters move (bounded wait,
   `WORKFLOWD_AGENT_RUN_VERIFY_TIMEOUT_MS`, default 120s). A session that
   never generates is aborted and the dispatch refused with
   `no_first_token`. A quota-dead route can no longer report "dispatched".
5. **Supervision.** After the receipt, the daemon's watchdog polls the run's
   token counters. No progress within `WORKFLOWD_AGENT_RUN_PROGRESS_WINDOW_MS`
   (default 20 minutes) → the session is interrupted and re-prompted in place
   with a continuation prompt (bounded by
   `WORKFLOWD_AGENT_RUN_MAX_ATTEMPTS`), then escalated to
   `operator_required` with the diagnostic trail. The caller never babysits.

With `parent_session_id` + `resume_prompt`, the runner also registers the
parent's custody (idempotently) and an agent wait in the same dispatch, so
one call means "run this and wake me when it finishes". Without them the
receipt carries the child's custody id for a later `wait_for_agent` call.

Parents come in two kinds (`parent_kind`, default `opencode`):

- `opencode` — a session on the managed OpenCode server, woken via the
  server API by the OpenCode resume worker.
- `claude` — a Claude Code session on the daemon's host, woken by the
  Claude resume worker through two `claude -p --resume` turns (the wake
  document, then the structured-ack extraction). Requires
  `parent_directory`, the cwd the session was created in; the session
  transcript must exist under `~/.claude/projects/` for that directory.
  Waking Claude sessions on *other* hosts is the cross-machine routing
  slice (workflowd-b3b.23) and is not supported yet; Codex parents are
  workflowd-b3b.21.

The dispatch call holds its HTTP request open through verification, so it is
the one write tool that can take a couple of minutes to ack. It is still a
receipt: end the turn after it arrives.

## Authorization

Reads need no credential beyond reaching the transport (loopback or your
tailnet). Both write tools are gated by a bearer token:

- `WORKFLOWD_MCP_TOKEN` — token value directly (development only).
- `WORKFLOWD_MCP_TOKEN_FILE` — path to a file containing the token. The
  shipped systemd unit provides this via `LoadCredential=mcp-token:...` and
  `WORKFLOWD_MCP_TOKEN_FILE=%d/mcp-token`, matching the other workflowd
  units.

When neither is set, the server starts read-only and both write tools refuse
every call. The token is never logged or echoed, including in error text.

`wait_for_agent` additionally needs to reach the daemon's agent-wait ingress,
which carries its own token:

- `WORKFLOWD_DAEMON_URL` — base URL of the workflowd daemon, e.g.
  `http://127.0.0.1:8787`. Must be absolute HTTP(S) and carry no credentials.
- `WORKFLOWD_AGENT_WAIT_TOKEN` / `WORKFLOWD_AGENT_WAIT_TOKEN_FILE` — the
  daemon's `WORKFLOWD_AGENT_WAIT_TOKEN`, supplied the same way as the MCP
  token. Set exactly one source.

`dispatch_agent` reaches the daemon's agent-run ingress the same way:

- `WORKFLOWD_AGENT_RUN_TOKEN` / `WORKFLOWD_AGENT_RUN_TOKEN_FILE` — the
  daemon's `WORKFLOWD_AGENT_RUN_TOKEN`, supplied the same way. Set exactly
  one source.

A tool whose token is missing stays disabled and refuses calls with a
message naming the missing settings. A daemon token without
`WORKFLOWD_DAEMON_URL`, or a daemon URL with no daemon token at all, is a
startup error rather than a silently half-configured tool.

## Server install (mint)

```sh
mkdir -p ~/.config/workflowd
printf 'WORKFLOWD_MCP_PORT=8791\nWORKFLOWD_DAEMON_URL=http://127.0.0.1:8787\n' \
  > ~/.config/workflowd/mcp.env
umask 077 && openssl rand -hex 32 > ~/.config/workflowd/mcp-token
# Reuse the same secret the daemon loads as WORKFLOWD_AGENT_WAIT_TOKEN_FILE,
# so both ends of the proxy agree.
umask 077 && openssl rand -hex 32 > ~/.config/workflowd/agent-wait-token
cp -f deploy/systemd/workflowd-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now workflowd-mcp.service
tailscale serve --bg --https=8791 http://127.0.0.1:8791
```

## Agent install

Claude Code:

```sh
claude mcp add --transport http workflowd https://mint.<tailnet>.ts.net:8791/mcp \
  --header "Authorization: Bearer $(cat ~/.config/workflowd/mcp-token)"
```

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "workflowd": {
      "type": "remote",
      "url": "https://mint.<tailnet>.ts.net:8791/mcp",
      "headers": {
        "Authorization": "Bearer {file:~/.config/workflowd/mcp-token}"
      }
    }
  }
}
```

Agents that only need read tools can omit the Authorization header entirely.

## HTTP surface: `POST /workflows/agent-waits`

`wait_for_agent` is a thin proxy over this endpoint on the workflowd daemon.
Both surfaces share one handler (`AgentWaitIngress` in
`src/kernel/agent-wait-ingress.ts`), so they cannot drift: custody rules,
identity derivation, prompt wrapping and duplicate semantics are decided in
exactly one place.

The route is registered only when the daemon is configured with an agent-wait
token, the same way `/workflows/qrspi` and `/workflows/test-jobs` are gated.
Without it the path 404s.

- `WORKFLOWD_AGENT_WAIT_TOKEN` / `WORKFLOWD_AGENT_WAIT_TOKEN_FILE` — bearer
  token for the endpoint; at least 8 characters. Set exactly one source.
- `WORKFLOWD_AGENT_WAKE_AGENT` — opencode agent used to prompt a woken
  parent. Defaults to `build`.

Request bodies use the daemon's camelCase convention (the MCP tool translates
from its own snake_case arguments):

```http
POST /workflows/agent-waits
Authorization: Bearer <WORKFLOWD_AGENT_WAIT_TOKEN>
Content-Type: application/json

{
  "parentSessionId": "parent-stable",
  "childSessionId": "child-stable",
  "resumePrompt": "The child finished; read its result and continue.",
  "idempotencyKey": "optional-stable-identity"
}
```

Responses:

| Status | Meaning |
| --- | --- |
| 202 | Registered. Body is `{ waitId, instanceId, status }` with `status` either `registered` or `duplicate`. |
| 400 | Malformed JSON or payload. |
| 401 | Missing or wrong bearer token. |
| 409 | Custody or immutable idempotency conflict. Custody bodies carry a precise reason and detail; immutable replay conflicts carry `reason: "idempotency_conflict"` without internal detail. |
| 413 | Body exceeds `WORKFLOWD_MAX_WEBHOOK_BYTES`. |
| 500 | Store fault; details stay server-side. |

## HTTP surface: `POST /workflows/agent-runs`

`dispatch_agent` is a thin proxy over this endpoint; both surfaces share the
`AgentRunIngress` handler in `src/kernel/agent-run-ingress.ts`. The route is
registered only when the daemon is configured for agent runs; without that
the path 404s.

Daemon configuration (all under the same optional section — the token
enables it, the routes and repositories are then required):

- `WORKFLOWD_AGENT_RUN_TOKEN` / `WORKFLOWD_AGENT_RUN_TOKEN_FILE` — bearer
  token for the endpoint; at least 8 characters. Set exactly one source.
- `WORKFLOWD_AGENT_RUN_ROUTES` — comma-separated `name=provider/model`
  pairs, e.g. `implement=zai-coding-plan/glm-5.3-flash,hard=anthropic/claude-fable-5`.
  The only place provider-prefixed model ids are ever written.
- `WORKFLOWD_AGENT_RUN_REPOSITORIES` — comma-separated `name=/absolute/path`
  pairs naming the dispatchable repositories. This is a security allow-list:
  dispatch is arbitrary prompt execution in the named directory's worktrees.
- `WORKFLOWD_AGENT_RUN_AGENT` — opencode agent for spawned sessions
  (default `build`; deployments use `remote-worker`).
- `WORKFLOWD_AGENT_RUN_VERIFY_TIMEOUT_MS` (120000),
  `WORKFLOWD_AGENT_RUN_VERIFY_POLL_MS` (2000),
  `WORKFLOWD_AGENT_RUN_PROGRESS_WINDOW_MS` (1200000),
  `WORKFLOWD_AGENT_RUN_MAX_ATTEMPTS` (3).

```http
POST /workflows/agent-runs
Authorization: Bearer <WORKFLOWD_AGENT_RUN_TOKEN>
Content-Type: application/json

{
  "route": "implement",
  "repository": "workflowd",
  "prompt": "Fix the flaky retry test and push the branch.",
  "parentSessionId": "ses_parent",
  "resumePrompt": "Child finished; review its branch.",
  "idempotencyKey": "optional-stable-identity"
}
```

Responses:

| Status | Meaning |
| --- | --- |
| 202 | Dispatched and first-token-verified. Body is `{ runId, sessionId, nativeSessionId, providerId, modelId, outputTokens, status, wait? }` with `status` either `dispatched` or `duplicate`. |
| 400 | Malformed JSON or payload. |
| 401 | Missing or wrong bearer token. |
| 409 | Refused with a machine-readable reason: `provider_prefixed_route`, `unknown_route`, `ambiguous_route`, `unknown_repository`, `provider_not_authenticated`, `model_not_available`, `invalid_wait_pairing`, `missing_parent_session`, `no_first_token`, `run_conflict` — or an idempotency/custody conflict. |
| 413 | Body exceeds `WORKFLOWD_MAX_WEBHOOK_BYTES`. |
| 500 | Store or provider fault; details stay server-side. |

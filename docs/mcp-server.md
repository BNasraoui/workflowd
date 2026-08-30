# Workflowd MCP server

A thin remote MCP server over the authoritative workflowd SQLite store. It
runs on mint beside the coordinator, listens on loopback
(`127.0.0.1:$WORKFLOWD_MCP_PORT`, default 8791), and is fronted by
`tailscale serve` the same way as the opencode server. The MCP process holds
no workflow state of its own — every tool call reads or writes the same
database the coordinator and the remote-enqueue CLI use.

The server targets MCP revision **2025-11-25** using SDK 1.30.0. All five
tools advertise an `outputSchema` and return the corresponding
`structuredContent` in addition to a human-readable text rendering. Tool
names use the SEP-986 canonical character set. The three query tools carry
`readOnlyHint`; the two receipt tools carry non-destructive and idempotency
annotations.

A tool's declared `outputSchema` describes its **success** payload only. On
`isError: true` results the tools deliberately deviate from it: refusals with
a machine-readable cause (for example `wait_for_agent`'s
`idempotency_conflict`) carry the daemon's refusal object
(`{error, reason?, detail?}`) as `structuredContent`, and other failures carry
text only. The MCP spec does not pin down `structuredContent` conformance for
error results and the SDK does not validate it, so clients should only match
error payloads against the refusal shape, never the success schema.

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

`enqueue_probe` with an explicit `probe_id` is idempotent (the same identity
maps to the same job); omitting it generates a fresh probe identity per call.

Resuming an OpenCode session when the probe completes is designed but not
wired in this slice: the kernel does not yet record a typed event at job
completion, so there is no condition a durable wait could match. The
parameter will return once that surface exists.

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

Omit all three and `wait_for_agent` stays disabled, refusing calls with a
message naming the missing settings. Setting a token without
`WORKFLOWD_DAEMON_URL` (or vice versa) is a startup error rather than a
silently half-configured tool.

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

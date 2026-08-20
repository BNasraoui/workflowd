# Workflowd MCP server

A thin remote MCP server over the authoritative workflowd SQLite store. It
runs on mint beside the coordinator, listens on loopback
(`127.0.0.1:$WORKFLOWD_MCP_PORT`, default 8791), and is fronted by
`tailscale serve` the same way as the opencode server. The MCP process holds
no workflow state of its own — every tool call reads or writes the same
database the coordinator and the remote-enqueue CLI use.

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

`enqueue_probe` with an explicit `probe_id` is idempotent (the same identity
maps to the same job); omitting it generates a fresh probe identity per call.

Resuming an OpenCode session when the probe completes is designed but not
wired in this slice: the kernel does not yet record a typed event at job
completion, so there is no condition a durable wait could match. The
parameter will return once that surface exists.

## Authorization

Reads need no credential beyond reaching the transport (loopback or your
tailnet). The single write tool is gated by a bearer token:

- `WORKFLOWD_MCP_TOKEN` — token value directly (development only).
- `WORKFLOWD_MCP_TOKEN_FILE` — path to a file containing the token. The
  shipped systemd unit provides this via `LoadCredential=mcp-token:...` and
  `WORKFLOWD_MCP_TOKEN_FILE=%d/mcp-token`, matching the other workflowd
  units.

When neither is set, the server starts read-only and `enqueue_probe` refuses
every call. The token is never logged or echoed, including in error text.

## Server install (mint)

```sh
mkdir -p ~/.config/workflowd
printf 'WORKFLOWD_MCP_PORT=8791\n' > ~/.config/workflowd/mcp.env
umask 077 && openssl rand -hex 32 > ~/.config/workflowd/mcp-token
cp deploy/systemd/workflowd-mcp.service ~/.config/systemd/user/
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

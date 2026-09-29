# CI and OpenCode evidence preflight — 2026-09-29

Source head: `75aae75`. `git fetch origin && git pull --ff-only` reported
already up to date. The owner authorized reading the existing App credentials,
but required stopping if an App setting needed changing.

Read-only authenticated requests to `GET /app`, `GET /app/hook/config`, and
`GET /app/installations` succeeded. Only the App ID was parsed from the production
env file; the private key and webhook secret were copied into a private temporary
directory. No credential values, JWTs, webhook URL, or raw API responses were
logged. Sanitized observations:

```json
{
  "permissions": {
    "checks": "write",
    "issues": "write",
    "metadata": "read",
    "pull_requests": "write"
  },
  "events": ["issue_comment", "pull_request"],
  "installation_account": "BNasraoui",
  "installation_suspended": true,
  "webhook_url_configured": true
}
```

The webhook configuration response did not report an `active` field; webhook
active state was not established. A configured URL does not prove active delivery.

## Owner changes required before resuming

1. Unsuspend the existing App installation for `BNasraoui`.
2. Grant repository **Actions: Read-only** and approve the updated permission on
   that installation. Existing Checks write permission is sufficient for reads.
3. Subscribe the App to **Workflow run** events. **Check suite** is an additional
   supported event, but is not required for a workflow-run-only evidence run.
4. Verify that webhook delivery is active; enable it if disabled. Keep its current
   URL: the planned evidence path can retrieve and locally replay the original
   delivery bytes and signature without routing GitHub to the scratch host.

Changing these settings can restore production event delivery. The owner must
choose a safe window; this run did not change settings or contact production
service endpoints. No installation tokens or CI runs were created.

## Scenario results

FAIL means the requested evidence remains unmet, including scenarios not run
because of the mandatory stop. PASS entries below are explicitly carried forward
from the prior evidence at the unchanged source head; they were not rerun.

| # | Scenario | Result | Basis |
|---|---|---|---|
| 1 | CI success and new turn | FAIL | App prerequisites; not run |
| 2 | CI failure includes failing jobs | FAIL | App prerequisites; not run |
| 3 | Duplicate webhook delivers once | FAIL | CI mailbox proof still missing |
| 4 | Late subscription | FAIL | App prerequisites; not run |
| 5 | Two CI worker threads | FAIL | App prerequisites; not run |
| 6 | Agent-run completed and cancelled | PASS | Prior evidence only |
| 7 | Cross-run peer credentials | PASS | Prior evidence only |
| 8 | Mailbox failure requires operator | PASS | Prior evidence only |
| 9 | Restart between persist and deliver | PASS | Prior agent-run evidence only |
| 10 | Unconfigured repository ignored | PASS | Prior evidence only |
| 11 | Defaults off uses legacy exec | PASS | Prior evidence only |
| 12 | OpenCode resident completion | FAIL | Unsupported; implementation deferred by mandatory stop |

The harness remains Codex-only. No OpenCode support, real CI fixture, or original
GitHub delivery replay is claimed. The only committed changes are evidence
documentation. The previous full logs remain linked in PR #57's original
`## Evidence` comment.

Cleanup: temporary credential copies were deleted by the temporary-directory
context before reporting. No Codex auth copy, scratch service, branch, CI run,
database, or NATS instance was created. No existing process was signalled and no
production configuration was edited.

# Agent inboxes and CI

CI observations belong to an exact repository and head SHA. They do not advance
PR generations, authorize publication, or transfer session/worktree custody.
A completed check suite is evidence to refresh the workflow inventory, not proof
that every required workflow passed. The explicit workflow-name policy avoids
passing a SHA because one of several workflows finished first. Missing workflows
remain pending. This policy covers Actions workflows; external check providers
and legacy commit statuses are not required-check policy inputs.

## CI ingress and waits (off by default)

Set `WORKFLOWD_CI_ENABLED=true`, `WORKFLOWD_CI_TOKEN_FILE` to a dedicated bearer
secret file, and `WORKFLOWD_CI_REPOSITORIES` to JSON such as:

```json
[{"repository":"BNasraoui/workflowd","installationId":123,"workflows":["CI"]}]
```

Use the GitHub App's actual installation ID and exact workflow names. Configure
`WORKFLOWD_NATS_SERVERS` and one of the existing `WORKFLOWD_NATS_CREDS_FILE` or
other NATS authentication settings. Provision permission to manage
`WORKFLOWD_CI_V1` and publish `workflowd.v1.ci.>`; it is a file-backed, limits-retained
stream (24 hours, 64 MiB). Subjects encode repository names as UTF-8 hex followed
by the SHA. `.completed` subjects carry webhook observations; the base SHA
subject carries aggregate state. SQLite sequences identify aggregate events;
GitHub delivery IDs identify observations. Publication retries use those IDs as
JetStream message IDs. Consumers must tolerate duplicates beyond NATS's dedup window.

Add **Actions: read** to the App's repository permissions, retain **Checks: read**,
and subscribe to **Workflow run** and **Check suite** webhook events. Approve the
new installation permissions. Signed completion deliveries and publication
intents commit before HTTP 202. Outbox publication is independent of GitHub
reconciliation, so NATS interruption does not lose accepted deliveries.

The shared reconciliation worker examines at most one watched repository/SHA per
minute, using an installation client and ETags. Each pass allows one inventory
request and up to ten failed-workflow job requests, each bounded to 100 records.
Larger inventories fail closed; they never silently become successful. Failures
back off five minutes. Targets expire after 24 hours without a waiter. The wait
API registers targets, so an entirely missed webhook can still be recovered.
Reruns are selected by newest run ID and attempt. Reconciliation can change a
previous terminal result; callers must wait on the intended SHA after starting
its workflows, not assume a past result predicts future reruns.

Run the repository CLI using:

```sh
WORKFLOWD_URL=http://127.0.0.1:8787 \
WORKFLOWD_CI_TOKEN_FILE=/path/to/ci-token \
bun run workflowd wait ci --repo BNasraoui/workflowd --sha "$HEAD_SHA" --timeout 3600
```

The CLI reads durable state, then subscribes by bounded HTTP long-poll with the
last SQLite event sequence. This replay survives process/server restarts and
NATS retention expiry. It does not poll GitHub. Heartbeats go to stderr every
60 seconds; the final JSON includes conclusion and failing job names. Exit codes:
0 success, 1 failing CI, 2 timeout/transport/configuration failure. The maximum
wait is 24 hours. HTTPS is required except on loopback. The CI bearer grants read
and watch access only to configured repositories; do not distribute a broader
workflow ingress token.

The external cargo shim can replace its `sleep 2`/GitHub checks loop with this
single command, preserving its exit status. No shim file is changed by this PR.

## Rollout boundary

These settings are absent by default. Enabling them requires an owner-planned
workflowd restart after existing work has drained, plus App permission approval
and NATS provisioning. Implementation and tests do not restart or reconfigure
any host service. Roll back by removing the feature settings at the next planned
restart; durable CI history remains in SQLite.

## Worker GitHub identity (off by default)

Set `WORKFLOWD_WORKER_GITHUB_ENABLED=true`,
`WORKFLOWD_WORKER_GITHUB_SECRET_FILE` (a dedicated random secret of at least 32
characters), `WORKFLOWD_WORKER_GITHUB_DIRECTORY` (an absolute private directory
for per-run capability files), and `WORKFLOWD_WORKER_GITHUB_ENDPOINT` (the
workflowd HTTPS URL or loopback HTTP URL). Set
`WORKFLOWD_WORKER_GITHUB_REPOSITORIES` to explicit dispatch-name policies:

```json
[{"name":"workflowd","repository":"BNasraoui/workflowd","installationId":123,"permissions":{"actions":"read","checks":"read","contents":"write","pull_requests":"write"}}]
```

`name` must match the existing agent-run repository allow-list. No caller can
request a different repository or elevate permissions. Installation tokens are
cached with concurrent lookup deduplication and refreshed five minutes before
expiry. Tokens remain redacted in the service; only the authenticated, no-store
HTTP response unwraps them. Each capability is bound to one live dispatch and
expires after 24 hours. Completed/failed runs immediately lose broker access.

Dispatch prompts include an absolute command-wrapper path and a mode-0600
capability file path. The wrapper obtains the current App token for every `gh`
command, overrides inherited personal tokens, disables credential debug tracing,
and fails closed if the broker refuses it. `--git` supports HTTPS Git using a
credential helper restricted to github.com. SSH Git authentication is outside
this broker. Workers must use the supplied wrapper; it does not alter a shared
OpenCode server's global environment or the user's saved gh credentials.

Approve **Actions: read**, **Checks: read**, and the explicit Contents/Pull
requests/Issues permission levels in each policy on the GitHub App installation.
Token creation fails closed when a requested permission is unavailable. The
App private key never leaves workflowd. Permission and identity changes take
effect on the owner's planned restart; existing dispatched workers are not
retrofitted or interrupted.

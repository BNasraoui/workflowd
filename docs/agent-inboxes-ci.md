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

Migrations always apply on startup, even with every feature flag absent.
Migration 0020 adds `ci_targets`, `ci_deliveries`, and `ci_events` plus their
target/outbox/due indexes. Migration 0021 adds `resident_threads` and
`resident_inbox` plus the pending-inbox index. They are additive: existing
dispatch tables and rows are unchanged. They also add migration-ledger entries.

For rollback, drain resident work and disable the flags at an owner-planned
restart. Older code can leave these unused tables in place. Do not delete the
tables alone while retaining their migration-ledger entries. If schema removal
is required, stop writes during an owner-controlled maintenance window and
restore a full pre-upgrade SQLite backup (including its migration ledger);
that discards all post-backup writes. Preserve a current backup first. This PR
does not perform any rollback or service operation.

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

## Resident Codex dispatch (off by default)

Set `WORKFLOWD_CODEX_RESIDENT_ENABLED=true`,
`WORKFLOWD_CODEX_RESIDENT_HOME` to a dedicated absolute Codex data directory, and
`WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE` to a separate random secret of at least 32
characters. The resident home must differ from `~/.codex`; the owner must arrange
Codex authentication there before cutover. Set `WORKFLOWD_URL` to the workflowd
endpoint reachable by worker commands. Enable CI as above and configure the
existing agent-run Codex routes. Where the dispatch repository name differs from
GitHub's full name, add `"dispatchRepository":"workflowd"` to its CI policy.

workflowd owns one long-lived `codex app-server --listen stdio://` child using
that private home. It neither uses systemd to manage that child nor connects to
an existing managed Codex daemon. Each dispatch gets its own thread, cwd, model,
`approvalPolicy: never`, and `sandbox: danger-full-access`, preserving the trusted
worker posture of the existing exec path. The experimental API capability is
explicitly negotiated. Tested against the installed Codex 0.156 protocol.

Dispatch instructions give the worker a resident wait helper. After it registers
an authenticated wait for its custodied thread and configured repository, it
ends its turn with “waiting for CI”. The service stores the waiting turn ID and
deadline. Its completion does not finish the agent run. A terminal CI state or
wait timeout creates a durable inbox entry and calls `thread/queue/add`; an idle
thread starts a turn, while an active thread receives it after its current turn.
No shell sleep or finished `codex exec` resume is involved.

After app-server restart, workflowd reloads persisted thread IDs with
`thread/resume` (the app-server reload operation), restores their cwd/model/policy,
and checks history. Interrupted active work gets a queued recovery event. Waiting
threads retain their waits. Lost queue acknowledgements are reconciled against
queued submission IDs and persisted user-message client IDs. If neither proves
acceptance, the inbox and run require operator attention instead of blind replay.
The automatic app-server restart budget is three per workflowd lifetime.

All threads retain existing kernel session and worktree custody; CI ingress does
not grant cleanup or publication authority. Current Codex parent/child wait
pairing restrictions remain in force. The default remains `codex exec` when the
resident flag is absent. Disable the flag only after resident work has drained;
exec cannot take over an in-flight resident inbox.

Cutover requires an owner-planned workflowd restart after active workers have
finished, staging private Codex auth, and confirming the experimental protocol
on the deployed Codex version. This PR does not modify units, managed daemon
configuration, external shims, or live workers.

Protocol references: [GitHub installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[workflow-run API permissions](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository),
and [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate).
The Codex wire shapes were checked against locally generated experimental types
from Codex 0.156 in an isolated scratch home, in addition to the prior
`explore/agent-inboxes` probes.

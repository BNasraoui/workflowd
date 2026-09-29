# Agent inboxes and CI

CI observations belong to an exact repository and head SHA. They do not advance
PR generations, authorize publication, or transfer session/worktree custody.
A completed check suite is evidence to refresh the workflow inventory, not proof
that every required workflow passed. The explicit workflow-name policy avoids
passing a SHA because one of several workflows finished first. Missing workflows
remain pending. This policy covers Actions workflows; external check providers
and legacy commit statuses are not required-check policy inputs.

## CI ingress (off by default)

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
back off five minutes. Targets expire after 24 hours without renewed registration. Subscription registration
starts reconciliation, so an entirely missed webhook can still be recovered.
Reruns are selected by newest run ID and attempt. Reconciliation can change a
previous terminal result; callers must wait on the intended SHA after starting
its workflows, not assume a past result predicts future reruns.

## Agent pattern: push, subscribe, end the turn

Push the intended head, then call the resident workflowd MCP tool
`subscribe_to_event` with `{"kind":"ci","repository":"owner/repo","sha":"HEAD_SHA"}`.
For another managed run, use `{"kind":"agent_run","run_id":"RUN_ID"}`.
Wait only for the registration receipt, then **end the turn**. Continue when the
single completion message arrives. The equivalent run-bound shell call is
`bun /path/to/workflowd/src/resident/subscribe.ts --repo owner/repo --sha HEAD_SHA`
(or `--agent-run RUN_ID`). Registration does not block or emit heartbeats.
The external cargo shim stops polling: its resident worker pushes and subscribes,
then workflowd wakes that worker through its mailbox. The shim is not edited here.

For Codex, the tool runs in a per-run stdio MCP process configured on workflowd's owned
app-server child. The daemon verifies the socket peer's ancestry and resolves
that run's custodied thread; tool arguments cannot supply a subscriber identity.
CI selectors are restricted to the caller's configured repository; agent-run
selectors must name another managed run in the same repository. Shared HTTP MCP
bearers and shared OpenCode process roots do not grant this subscription authority.
Resident Codex and opt-in resident OpenCode sessions are supported. OpenCode
uses a separate run-bound capability provisioned into its session environment;
a shared HTTP MCP bearer or a claimed run ID alone is insufficient.

Subscription identity is the subscriber plus normalized selector. Repeating it,
including after delivery, never creates another message. Already-final jobs enqueue
immediately. Each subscription captures one final observation; later reruns of the
same SHA do not rearm it. CI results include conclusion, failing job names, and
Actions run links. Agent results include final status and a native-session summary
pointer (or the durable run ID if the run never acquired a session).

Subscriptions reuse `kernel_workflow_instances`, `kernel_waits`, and
`kernel_wait_event_deliveries`. Consuming a matched wait and inserting its resident
inbox message is one transaction. The inbox uses the subscription ID as its stable
queue message ID. Its `prepared`/`sending`/`delivered`/`operator_required` state is
the subscription's delivery state; before an inbox row exists the kernel wait is
pending. Queue failures or a gone mailbox require operator attention, with no blind
retry. Inspect these records by subscription ID from the receipt.

Existing `wait_for_agent` and dispatch parent wakes keep their durable wait and
wake-by-resume paths for one-shot workers: OpenCode uses `prompt_async`, and Claude
uses its resume worker. They retain their existing provider and custody rules.
Mailbox subscriptions reuse the durable wait core but reduce to resident inboxes
instead of scheduling a one-shot resume. They require resident workers; a completed
`codex exec` process cannot receive a mailbox message.

## Rollout boundary

These settings are absent by default. Enabling them requires an owner-planned
workflowd restart after existing work has drained, plus App permission approval
and NATS provisioning. Implementation and tests do not restart or reconfigure
any host service. Roll back by removing the feature settings at the next planned
restart; durable CI history remains in SQLite.

Migrations always apply on startup, even with every feature flag absent.
Migration 0021 adds `ci_targets`, `ci_deliveries`, and `ci_events` plus their
target/outbox/due indexes. Migration 0022 adds `resident_threads` and
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
`WORKFLOWD_WORKER_GITHUB_DIRECTORY` (an absolute empty gh configuration directory),
and `WORKFLOWD_WORKER_GITHUB_SOCKET` (an absolute Unix socket path with an existing
parent directory). Set
`WORKFLOWD_WORKER_GITHUB_REPOSITORIES` to explicit dispatch-name policies:

```json
[{"name":"workflowd","repository":"BNasraoui/workflowd","installationId":123,"permissions":{"actions":"read","checks":"read","contents":"write","pull_requests":"write"}}]
```

`name` must match the existing agent-run repository allow-list. No caller can
request a different repository or elevate permissions. Installation tokens are
cached with concurrent lookup deduplication and refreshed five minutes before
expiry. Tokens remain redacted in the service; only the authenticated, no-store
socket response unwraps them. Access is bound to one live dispatch and
expires after 24 hours. Completed/failed runs immediately lose broker access.

The workflowd-owned Unix socket obtains Linux peer PID/UID using
`getsockopt(SOL_SOCKET, SO_PEERCRED)`. At dispatch workflowd records the owned
root PID and its /proc birth time; each request must descend from that root.
The run ID and socket path enter only that run's environment. No shared
capability directory, bearer file, or prompt credential grants access. Prompts
contain only wrapper instructions. Tokens reach commands through their own
environment, never command lines or logs. Shared OpenCode dispatch cannot supply
an independent process root and fails closed when worker identity is enabled.

This prevents accidental or prompt-injected use of another run's identity. It
does **not** protect against a deliberate same-UID attacker, who can inspect or
modify other same-user processes. That requires separate OS users or containers.
Linux is required by this implementation. On macOS the equivalent PID check
would use `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` plus `getpeereid` and validated
process ancestry; UID-only `getpeereid` is insufficient. Unsupported hosts fail
closed rather than falling back to a bearer file.

The wrapper obtains the current App token for every `gh` command, overrides
inherited personal tokens, disables credential debug tracing, and fails closed
if the broker refuses it. `--git` supports HTTPS Git using a credential helper
restricted to github.com. SSH Git authentication is outside this broker.

Approve **Actions: read**, **Checks: read**, and the explicit Contents/Pull
requests/Issues permission levels in each policy on the GitHub App installation.
Token creation fails closed when a requested permission is unavailable. The
App private key never leaves workflowd. Permission and identity changes take
effect on the owner's planned restart; existing dispatched workers are not
retrofitted or interrupted.

## Resident OpenCode delivery (off by default)

Set `WORKFLOWD_OPENCODE_RESIDENT_ENABLED=true` and
`WORKFLOWD_OPENCODE_RESIDENT_SOCKET` to a dedicated absolute Unix socket path
with an existing parent directory. Enable CI and managed agent-run dispatch.
The socket must differ from the resident Codex socket. These flags take effect
only at an owner-planned cutover; no running server or unit is reconfigured by
this change.

Before the first prompt, workflowd provisions a fresh 256-bit capability into
that OpenCode session's local shell environment using `session.environment`.
Only its hash is stored in workflowd’s SQLite database. The environment also identifies the calling
run and subscription socket. The run-bound shell helper shown above works
without caller-supplied identity arguments; `subscribe_to_event` uses the same
boundary when its stdio MCP process is launched with that session environment.
OpenCode dispatch instructions include the shell helper. This does not install
a shared MCP bearer, write credential files, or expose the capability in prompts.
The GitHub token broker still requires an owned Codex process tree; enabling it
does not grant OpenCode GitHub credentials.

Every registration checks the capability against the calling run, its verified
state, the native session, the configured OpenCode endpoint/server/host, and
reserved worktree custody. Selectors retain the same repository restrictions as
Codex. Pending waits and prepared inbox messages keep the managed run from being
finished by the watchdog. Parent completion observation waits for the resident
run to finish, so ending an intermediate turn does not wake its parent. The existing kernel waits and inbox transaction provide
one durable message per subscriber and selector, including late subscriptions.

Delivery uses the asynchronous prompt admission API with queue delivery. On this
branch's pinned OpenCode v2 client, that is `session.prompt` (the successor to
`prompt_async` / `promptAsync`): it durably admits an inbox input and schedules
execution, returning before the model answers. Active sessions receive the
message through their queue. Calls are bounded to 15 seconds. A missing session,
refusal, failed call, invalid custody, or uncertain acknowledgement moves the
inbox and active run to `operator_required`. There is no automatic prompt replay.
A restart with a `prepared` message sends it once; a restart with a `sending`
message requires an operator because the adapter cannot prove acceptance.
`delivered` means the server accepted the message, not that the resumed task has
finished. Inspect the subscription receipt/ID and durable inbox state to resolve
operator-required delivery.

Migration 0023 adds provider separation and the capability hash to resident
mailboxes; existing rows default to Codex. Each delivery worker reads only its
own provider's mailboxes. No real OpenCode server or credentials are needed for
the test suite: adapter doubles, an ephemeral HTTP fixture, Unix sockets, and
isolated SQLite databases cover both event kinds and restart/failure behavior.

## Resident Codex dispatch (off by default)

Set `WORKFLOWD_CODEX_RESIDENT_ENABLED=true`,
`WORKFLOWD_CODEX_RESIDENT_HOME` to a dedicated absolute Codex data directory, and
`WORKFLOWD_CODEX_RESIDENT_SOCKET` to an absolute Unix socket path with an existing
parent directory. The resident home must differ from `~/.codex`; the owner must arrange
Codex authentication there before cutover. Enable CI as above and configure the
existing agent-run Codex routes. Where the dispatch repository name differs from
GitHub's full name, add `"dispatchRepository":"workflowd"` to its CI policy.

workflowd owns one `codex app-server --listen stdio://` child per live run using
that private home. Distinct process trees let the Unix socket authenticate the
calling run with the same peer-credential/ancestry boundary as token brokerage.
The socket path and run identity are passed only through each child environment.
No service-wide bearer file authorizes subscriptions. It neither uses systemd to manage that child nor connects to
an existing managed Codex daemon. Each dispatch gets its own thread, cwd, model,
`approvalPolicy: never`, and `sandbox: danger-full-access`, preserving the trusted
worker posture of the existing exec path. The experimental API capability is
explicitly negotiated. Tested against the installed Codex 0.156 protocol.

Dispatch instructions give the worker the subscription pattern above. A registered
subscription keeps its original turn from finishing the agent run. The daemon
observes persisted job state and queues one result with `thread/queue/add`; an idle
thread starts a turn, while an active thread receives it after its current turn.
There is no agent-side polling. Multiple outstanding subscriptions retain the
resident worker until their results have arrived.

After app-server restart, workflowd reloads persisted thread IDs with
`thread/resume` (the app-server reload operation), restores their cwd/model/policy,
and checks history. Interrupted active work gets a queued recovery event. Waiting
threads retain their subscriptions. Lost queue acknowledgements are reconciled against
queued submission IDs and persisted user-message client IDs. If neither proves
acceptance, the inbox and run require operator attention instead of blind replay.
The automatic app-server restart budget is three per run per workflowd lifetime.

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

The mailbox work adds migration 0023 on top of existing migrations 0020–0022. The old single-target resident wait
columns remain unused for schema compatibility. Drain any earlier experimental
resident waits before cutover; they are not converted into new subscriptions.
Dispatch changes in PR #58 and `fix/credential-rotation-keeps-runs` are separate:
OpenCode mailbox provisioning adds an opt-in hook to `agent-run-ingress.ts`;
`runtime.ts` and the parent resume workers remain unchanged. The OpenCode
completion source defers parent wakes until a resident run finishes. Credential rotation must preserve the resident process root
(or re-register the new owned root) so socket authentication and mailbox custody
remain valid.

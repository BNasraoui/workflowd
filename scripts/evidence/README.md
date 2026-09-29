# Agent inbox evidence

Run manually from this checkout:

```sh
bun scripts/evidence/agent-inboxes.mjs
```

Requires Linux, Bun, Git, `nats-server`, `codex`, `opencode2`, and a working
`~/.codex/auth.json`. The harness copies only that auth file into a fresh private
directory, removes the copy at teardown, and does not read the normal Codex
configuration. `EVIDENCE_MODEL` optionally selects the Codex model.

Each invocation creates `.scratch/evidence/<timestamp>/` with its own home,
configuration, SQLite database, Git repository/worktrees, Unix sockets, NATS
JetStream store and loopback ports. It starts this branch's `src/main.ts` and a
separate OpenCode server needed by workflowd's startup validation. No systemd,
deployment checkout, existing daemon, production credentials or service ports
are used. The recorder forwards real Codex protocol traffic without synthesizing
responses. Only the mailbox-failure scenario stops its owned app-server before a
queue call. The restart scenario freezes and kills only the workflowd process
created by this invocation. Recorder cleanup checks process birth times before
signalling a recorded PID.

For scenarios 1–5, supply **separate test GitHub App credentials**, with Actions
read access to a repository containing successful and failing runs:

```sh
EVIDENCE_GITHUB_APP_ID=12345 \
EVIDENCE_GITHUB_INSTALLATION_ID=67890 \
EVIDENCE_GITHUB_KEY=/absolute/path/to/test-app.pem \
EVIDENCE_CI_FIXTURES=/absolute/path/to/fixtures.json \
bun scripts/evidence/agent-inboxes.mjs
```

The fixtures JSON contains real repository/run values:

```json
{
  "repository": "owner/test-repository",
  "workflows": ["CI"],
  "success": { "sha": "40-character-successful-commit-sha", "runId": 123 },
  "failure": {
    "sha": "40-character-failing-commit-sha",
    "runId": 456,
    "failingJobs": ["typecheck", "test"]
  }
}
```

Missing test credentials produce **BLOCKED**, not PASS. In that mode the harness
generates an invalid scratch App key: signed webhook ingress and JetStream
publication are still real, but authenticated GitHub reconciliation cannot
produce the aggregate mailbox result. No fake GitHub API or seeded CI result is
substituted. A webhook's conclusion does not bypass the PR's reconciliation
policy. Fixture workflow names must match the actual required workflows, and
failure job names must match GitHub's jobs API.

Scenario 6 completes one real worker and administratively cancels another
through the production `AgentRunStore.cancel` implementation. This branch has no
public cancellation endpoint. Scenarios 8 and 9 use agent-run terminal events,
so their mailbox failure/restart evidence does not depend on GitHub credentials.
Scenario 9 pauses the scratch delivery process, commits cancellation through the
real store, captures the persisted state and absent mailbox message, crashes the
scratch daemon, then restarts the same branch and database.

Scenario 12 is reported as unsupported: this PR's `subscribe_to_event` and
resident inbox adapter are Codex-only. Existing OpenCode parent wakes are a
different interface; this harness does not claim they prove resident OpenCode
subscriptions.

`logs/results.md` contains the result table. `logs/evidence.jsonl` contains
timestamped HTTP observations, SQLite snapshots, JetStream sequences/bodies and
process lifecycle records. `logs/codex.jsonl` contains the actual app-server
protocol, including tool receipts, queue requests, new turn IDs and model replies.
Other log files contain process diagnostics. Secrets known to the harness are
redacted before writing uploadable logs. Credentials and configs remain outside
`logs/` and are removed at teardown. Review **only the logs directory** before
publishing; never upload the scratch home, database or session files wholesale.

The command exits nonzero if any required scenario fails or is blocked. It does
not create a Gist or PR comment automatically. Publish reviewed logs explicitly
with `gh gist create` (secret by default), then link them in the PR evidence
comment. This script is outside `test/`, has no `.test.*` suffix, and is not added
to package scripts or GitHub Actions: **it does not run in CI**.

# Manual PR 59 custody evidence

Run from the repository root on a Linux host with a working systemd user manager:

```sh
bun install --frozen-lockfile
EVIDENCE_REAL_CODEX_BINARY=/absolute/path/to/codex bun scripts/evidence/credential-rotation.mjs
```

Authenticate `.scratch/evidence59/codex-home` independently before running the real
model case. Do not copy production credentials or use the normal Codex home.
Without an explicitly supplied binary the runner still exercises all controlled
process scenarios, but reports the required real model case as **FAIL / BLOCKED**
and exits nonzero. This is not complete merge evidence until that case passes.
The script refuses `CI`; it is not part of any package script or test glob.

The scratch host composes this branch's production HTTP routing, agent-run ingress,
SQLite migrations and stores, worktree creation, Codex dispatcher, worker and
recovery. It is a focused workflowd host, **not `src/main.ts`**: GitHub, the review
startup gate, remote NATS coordination, Claude and parent-wait integrations are
not exercised. The non-Codex check uses a deterministic OpenCode protocol fixture;
it proves route separation, not real OpenCode model execution. All timing, partial
line, signal and output-limit cases use actual fixture processes inside actual
transient user services. The separate real model case crosses the launch/restart
boundary with the supplied executable.

Each invocation creates a unique `.scratch/evidence59/run-*` tree containing its
own repository, worktrees, SQLite database, HTTP port, homes, logs and custody.
Only the independently authenticated scratch Codex home is shared between runs.
The host uses a sanitized environment; workers additionally run under `env -i`
so the user manager cannot inject ambient production credentials. No NATS server
is needed for these local ingress paths. No production unit or configuration is
changed. Unit names start with a unique `workflowd-evidence59-<timestamp>-` prefix.

A command probe pauses after successful `systemd-run` for the launch crash case.
The parent kills only its own host process, then starts a new host against the
same scratch database. SQLite triggers count actual terminal state changes;
parsed-event logs count partial-line consumption. The manager-unavailable case
uses an invalid bus address in the scratch host only. Output is limited to 4096
bytes per file and retention to one second for this runner; production defaults
remain 10 MiB and seven days. The runner uses the CLI default model route, whose
stored model identifier is `<cli-default>`.

Normal completion, failures, SIGINT and SIGTERM enter cleanup. Cleanup targets
only names recorded by this invocation before launching, waits for cgroup
inactivity, resets failed scratch units and asserts no matching unit remains.
Logs and databases remain for inspection; finished custody may already have been
removed by the retention scenario. SIGKILL of the runner itself cannot execute
cleanup: its `owned-*.service` files identify the exact units to inspect and
remove. Never use a broad workflowd unit glob for cleanup.

`summary.md`, `evidence.jsonl` and `host-*.log` contain the evidence. Publish only
these allow-listed logs after redaction; never upload the Codex home, database,
environment or arbitrary scratch files. The suite intentionally returns nonzero
for any failed assertion and continues independent cases so failures stay visible.

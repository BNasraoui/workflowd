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
deployment checkout, existing daemon, or production service ports are used.
Production App credentials are read only by the explicitly authorized wrapper. The recorder forwards real Codex protocol traffic without synthesizing
responses. Only the mailbox-failure scenario stops its owned app-server before a
queue call. The restart scenario freezes and kills only the workflowd process
created by this invocation. Recorder cleanup checks process birth times before
signalling a recorded PID.

For scenarios 1–5, use the owner-authorized App runner after the read-only
preflight. It requires exactly one active installation, exactly
`BNasraoui/workflowd`, accepted Actions read, and Workflow run / Check suite
subscriptions. It never changes App settings or triggers CI. Re-run only the
chosen existing job separately, then pass the App delivery IDs as decimal strings:

```sh
EVIDENCE_SUCCESS_DELIVERY=3845408192221683712 \
EVIDENCE_FAILURE_DELIVERY=3845408194853617664 \
bun scripts/evidence/github-app-run.mjs
```

The runner copies only the App ID, key, and webhook secret from the explicitly
authorized production configuration into a private worktree scratch directory.
It fetches the two completed deliveries, reconstructs their original bytes, and
requires an exact match against the original GitHub signature before replay.
The actual workflowd reconciler uses the App API; no aggregate results are seeded.
The CI policy is restricted to `BNasraoui/workflowd`. The negative repository test
uses a synthetic signed payload that is rejected before any GitHub API access.

All copied credentials, fixture signatures, and scratch App configuration are
removed on normal completion or failure. Allow the harness to finish cleanup;
do not kill its wrapper. Preflight observations are in
[the recorded result](./ci-opencode-preflight.md).

Scenario 6 completes one real worker and administratively cancels another
through the production `AgentRunStore.cancel` implementation. This branch has no
public cancellation endpoint. Scenarios 8 and 9 use agent-run terminal events,
so their mailbox failure/restart evidence does not depend on GitHub credentials.
Scenario 9 pauses the scratch delivery process, commits cancellation through the
real store, captures the persisted state and absent mailbox message, crashes the
scratch daemon, then restarts the same branch and database.

Scenario 12 uses the separate scratch OpenCode server with a credential-free
catalog model. It emits a short registration step to establish verified custody, then registers
an agent-run subscription through the session-bound socket command using the
absolute Bun executable, ends the turn, and receives one cancellation completion
and replies. The harness checks the durable inbox and actual session history.
No OpenCode credentials or production server are used.
`EVIDENCE_OPENCODE_MODEL` can select another available credential-free model.
OpenCode dispatch has a five-minute first-token limit for cold startup.
`EVIDENCE_SCENARIOS=7,12` runs the peer-bound prerequisite and OpenCode case only;
unselected rows are explicitly skipped. A listed model may still be unavailable
at dispatch, and a successful catalog lookup is not evidence of a model turn.

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

## Resident restart evidence (R1)

With explicit authorization to copy only the current Codex login file into the
private scratch home, run the focused real Codex scenario with:

```sh
EVIDENCE_COPY_AUTH=1 EVIDENCE_REAL_CODEX_BINARY=/absolute/path/to/codex \
  bun scripts/evidence/credential-rotation.mjs --full --scenario=R1
```

R1 starts this branch's `src/main.ts` with resident Codex enabled, records real
app-server protocol frames, interrupts only its scratch daemon during a turn,
and restarts it against the same SQLite database. It requires the run to finish
`completed` with one durable `restart:` message and a `turn/start` frame.
The private auth home is removed during cleanup. The run never restarts the
installed `workflowd.service`.

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

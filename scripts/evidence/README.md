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

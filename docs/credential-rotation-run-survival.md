# Credential rotation and agent-run survival

## Decision

Workflowd uses **Option B**: every Codex agent run executes in its own transient
systemd user service, outside `workflowd.service`'s control group. Workflowd
writes the prompt, event stream, stderr, terminal result, and a versioned
manifest under the state database directory in `agent-processes/<run-id>/`.
Before `systemd-run`, workflowd writes a launch nonce and deterministic unit
name. After launch it records systemd's `InvocationID`. On startup it enumerates
Codex runs in `spawning`, `spawned`, and `verified`, reconciles both identities
with the user manager, and resumes completion without launching a second
worker. A missing unit, an exited unit without a result, malformed custody, or
a reused unit name ends recovery with an operator-visible reason.

The transient service is named from a hash of the run ID. Interrupting an
observer does not signal that service. Explicit cancellation is available as
`DELETE /workflows/agent-runs/<run-id>`. It verifies the invocation, stops the
whole unit cgroup, waits for inactivity, and escalates to `SIGKILL` within a
bound before recording `cancelled`.

## Why Option A is unavailable

The installed `noscope 0.1.0` cannot rotate a credential into a file consumed
by an already-running child:

- `noscope mint` emits a JSON envelope to stdout and has no file-output or
  periodic-remint option.
- `noscope run` injects the minted credential into the child's environment
  once. Its `--restart-before-expiry` option deliberately stops the child so a
  supervisor restart can mint again.
- A provider `refresh` command may update noscope's internal lease, but
  `src/app/run.rs` states that environment injection is point-in-time and logs
  that a rotated credential never reaches the running child. Its conformance
  tests assert that warning.

Consequently the NATS client cannot receive the reminted credential while the
same workflowd process remains alive. Removing the scheduled restart would
eventually leave workflowd using expired NATS credentials.

## Behavior

The existing noscope/systemd rotation remains unchanged. When noscope stops
workflowd before credential expiry, systemd restarts workflowd with a newly
minted NATS credential. Codex transient services remain owned by the user
manager rather than by `workflowd.service`, so they continue running. The new
workflowd process reattaches to every unit-owning run and records its eventual
completion or failure in the existing agent-run store.

Prompts never appear in the transient unit's argument vector. Custody
directories and files are created with owner-only permissions. The wrapper
captures stdout and stderr with a 10 MiB limit per file; the observer reads only
newly appended, newline-terminated bytes. Finished custody is removed at
startup after seven days, while active run IDs are protected.

## Execution ownership seam

`CodexCliPort.ownership` makes integration with resident Codex threads explicit:

- `transient-exec`: this module owns one-shot `codex exec` launch, recovery,
  bounded observation, and exact-invocation cancellation.
- `resident-thread`: the resident supervisor owns process recovery and
  cancellation. Agent-run startup does not attach these threads; cancellation
  delegates once to `cancelRun`. The resident daemon retains the process root
  registered for run-bound peer authentication.

When rebasing with PR #57, its resident CLI declares
`ownership: "resident-thread"` and exposes supervisor cancellation as
`cancelRun(runId)`. Keep this PR's transient CLI as
`ownership: "transient-exec"`. Never give either mode both ownerships. PR #58's
interrupt-before-join behavior remains in the shared turn observer.

## Owner rollout

The Codex route requires a working user systemd manager plus `systemd-run` and
`systemctl`. Workflowd checks the manager at startup and logs a typed
`systemd_unavailable` reason; only the Codex route is refused, with no fallback
into `workflowd.service`'s cgroup. Verify the prerequisite before rollout:

```bash
systemctl --user show-environment
systemd-run --user --wait --quiet --collect --property=Type=oneshot true
```

The probe command creates only its own short-lived unit. No persistent service
or drop-in edit is required. Keep the existing noscope arguments, including:

```text
--env-key WORKFLOWD_NATS_CREDS --restart-before-expiry 300
```

After this change is merged, deploy the merged workflowd checkout and run:

```bash
bun install --frozen-lockfile
bun run check
systemctl --user restart workflowd.service
```

Perform that single restart only after the new code and dependencies are in
place. Thereafter the existing approximately six-hour scheduled restart may
continue unchanged. Before rollout, runs launched by the old version remain in
the old service control group and are not retroactively protected; allow them
to finish or schedule the rollout when none are active.

If a launch fails after its row is claimed, workflowd removes the incomplete
row and custody directory; retry the identical dispatch after correcting the
manager error. On restart, workflowd terminalizes stale or absent custody and
never attaches or signals a different invocation that reused the unit name.

## OpenCode reviewer availability

Recommendation: a temporarily unavailable PR-review model should eventually
degrade PR-review readiness rather than prevent the whole daemon from starting.
Agent-run recovery, remote coordination, and unrelated HTTP surfaces should be
able to come up while review work remains retryable or visibly unavailable.

This change does not alter that startup gate. The current configuration only
gates the fixer through `WORKFLOWD_FIX_WORK_ENABLED`; the reviewer is always a
configured core capability. Making only model absence non-fatal requires a
separate readiness state and job-level retry policy, not a small safe change
behind an existing setting.

### Full-daemon manual evidence

The manual runner can boot `src/main.ts` with isolated configuration, SQLite,
repository/worktrees, loopback listeners and a scratch unit namespace:

```sh
EVIDENCE_COPY_AUTH=1 EVIDENCE_REAL_CODEX_BINARY=/absolute/path/to/codex \
  bun scripts/evidence/credential-rotation.mjs --full
```

`EVIDENCE_COPY_AUTH=1` requires the owner's explicit permission: it copies only
`~/.codex/auth.json` into a fresh scratch `CODEX_HOME` and removes that copy in
`finally`. The scratch directory is ignored by git. Never publish auth files.
The real prompt requests a twelve-second sleep followed by `EVIDENCE59_REAL_OK`,
allowing the daemon to restart while the model's command is running. Assertions
check active custody during downtime, unchanged launch nonce and InvocationID,
exactly one completed transition, and the real final response/token usage.

The OpenCode startup availability gate and non-Codex route use an isolated HTTP
protocol fixture. GitHub uses a generated scratch key and no queued GitHub jobs;
remote coordination is disabled, so no NATS connection is made. Scenarios 1–8
use controlled executable workers for repeatable timing, signal trapping,
partial JSON writes and oversized output. Scenario 9 uses the OpenCode fixture.
The full daemon uses the production 10 MiB limit and seven-day retention;
scenario 7 ages only its scratch result timestamp by eight days. The full daemon
has no parser instrumentation, so scenario 6 asserts the persisted output and
single verification transition; the focused host additionally counts parsed events.

`WORKFLOWD_AGENT_RUN_CODEX_UNIT_PREFIX` optionally configures the existing
transient-unit namespace; its default remains `workflowd-agent-`. The manual
runner supplies a unique `workflowd-evidence59-<timestamp>-` prefix. Its PATH
shim launches real systemd units, enforces that prefix, clears ambient manager
environment for workers and optionally delays the launch acknowledgement for
scenario 2. No application services are replaced in the full daemon.

The 2026-09-29 full-daemon run at executable evidence commit `14b0137` passed
scenarios 1–9 and the real turn. During graceful daemon shutdown and recovery,
the real worker retained launch nonce `de5b8b6b-dc9e-4ddd-9408-cb5d87974a00` and
InvocationID `b7298eda9d82423fa76df5fa2536a0df`. It completed once with
`EVIDENCE59_REAL_OK` and 55 output tokens. All scratch authentication copies,
daemon processes and transient units were removed. Initial fixture failures
and the final passing run are retained in the PR's evidence archive.

[Full redacted logs and earlier attempts](https://gist.github.com/BNasraoui/5aee27dbe1c0cdd9ef3c1516988f6739).
Validation: `bun run check` passed with 281/281 Effect files, 1,398 tests,
0 failures and 3,247 assertions.

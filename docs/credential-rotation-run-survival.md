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

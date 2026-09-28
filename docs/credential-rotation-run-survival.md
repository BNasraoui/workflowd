# Credential rotation and agent-run survival

## Decision

Workflowd uses **Option B**: every Codex agent run executes in its own transient
systemd user service, outside `workflowd.service`'s control group. Workflowd
writes the prompt, event stream, stderr, terminal result, and a versioned
manifest under the state database directory in `agent-processes/<run-id>/`.
On startup it enumerates verified Codex runs, reopens their manifests, and
resumes completion from the durable event and result files without launching a
second worker.

The transient service is named from a hash of the run ID. Interrupting an
observer does not signal that service. Only an explicit refusal or stall calls
`systemctl --user kill` for the exact recorded unit.

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
workflowd process reattaches to verified runs and records their eventual
completion or failure in the existing agent-run store.

Prompts never appear in the transient unit's argument vector. Custody
directories and files are created with owner-only permissions, and stdout and
stderr are appended directly to durable files by systemd.

## Owner rollout

No service or drop-in edit is required. In particular, keep the existing
noscope arguments, including:

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

# Sandbox audit and PR execution

Phase D1 adds audit delivery and unprivileged PR execution. Publication remains disabled;
Phase D2 requires operator setup and a coordinator re-pin before live probes. Workers do
not change rulesets, App grants, workflow pins, production configuration or installed
agents. After the D1 candidate passes exact-head CI, the coordinator must record a
superseding pin before another live lease. The current pin remains
`1dfc34c2742ede3d1499b8bcd303fd487c2a3f7d` until that happens.

## Command status and public audit

The mint bridge wraps non-background `environment_run_cmd` calls that supply an explicit
command. A fresh 128-bit nonce identifies an exit marker printed by a parent shell.
The original command and requested shell are positional arguments; the wrapper executes
`"$2" -c "$1" wfd`. Neither is interpolated into the wrapper's shell source. The bridge
removes its marker before returning the tool result. Exactly one intact matching marker
with a status in 0–255 supplies `exitCode`. Background/default commands, missing,
duplicated, malformed or truncated markers and transport loss retain `exitCode: null`
and `outcome: "unknown"`. Successful MCP transport and `isError: false` do not establish
command success. Non-command tools have a null exit code.

Every bridge tool call reserves a canonical record under the controller's binding
folder, `audit/<sequence>.json`, before forwarding. Completion replaces the pending
unknown record before the tool result returns. Records contain run/lease identity,
sequence, a digest of the call ID, tool, command preview/digest, exit code and outcome.
A reservation failure leaves an `audit-failed` receipt; incomplete records and this
receipt prevent successful settlement. The record budget is 1,024 calls, 4 KiB each;
command previews are limited to 512 characters. Results, file contents and environments
are never copied into the audit. Recognizable credential strings are redacted. A command
preview is **public** and redaction cannot detect every caller-supplied secret.

Mint sends bounded JSON on stdin through the existing pinned SSH connection policy to
a fixed `runner-control audit` operation, separate from replaceable MCP stdio. No command
text enters the SSH command line.
The runner queues records by sequence, rejects conflicting replay and identity changes,
and bounds its queue to 4 MiB. The `hold` process prints escaped single-line
`workflowd.audit {...}` records on the same stdout used by the Actions hold step, then
advances its acknowledgement watermark. SSH receives only that watermark. Replaying
the same record does not print it again. A crash between stdout emission and checkpoint
can repeat a line; correlate/deduplicate by run, lease and sequence.

Settlement stops/revokes the session, captures the inert patch, drains the canonical
audit through the hold process, and only then requests Actions cancellation. Missing
or failed audit acknowledgement preserves an `operator_required` result while lease
cleanup still proceeds. The drain has a 30-second deadline; a large backlog that cannot
be confirmed within it requires operator review, never invented success. Mint's records
and `audit-receipt.json` are retained with the binding.

These records are operational evidence, not attestation: an agent-controlled runner
can inspect process arguments, forge output, alter its logs or lie about execution.
The nonce prevents ordinary command text from accidentally being mistaken for an exit
status; it is not a security boundary against a compromised runner. Correlate runner
logs with the retained mint records. No model, App, workflowd or NATS credential is
provided to the runner by this mechanism.

## PR execution boundary

All PRs, including same-repository PRs, use `pull_request`, explicit empty workflow/job
permissions, GitHub-hosted disposable jobs and fixed-repository anonymous HTTPS fetch.
Full source/base SHAs are supplied as environment values and validated before fetch.
No checkout credential, secret, OIDC grant, environment or shared writable cache is
supplied. Quality and test dependency installation ignore lifecycle scripts. Tests
still execute arbitrary repository code inside the disposable job.

The pinned Bun and Node setup actions have their default GitHub token explicitly
replaced with an empty string. Bun caching is disabled; Node has no cache input.
CodeQL's PR policy job has no checkout and explains that scanning waits for reviewed
main. The write-capable analysis job runs only for main pushes or schedules.

`bun src/sandbox/ci-policy.ts` inspects all workflow files. PR dependencies are
conservatively restricted to the two reviewed, pinned setup actions; local actions
and reusable workflow calls (including inherited secrets) are refused. The guard
checks effective permissions, runner class, privileged contexts, install policy and
the anonymous checkout snapshot. Its quality-matrix result feeds `Required checks`.
It rejects target/downstream privileged triggers. It cannot secure arbitrary edits
to its own implementation or repository scripts: the trust root remains the
operator-reviewed workflow snapshot and human review of workflow changes. Future
publishing must evaluate the trusted base policy before writing a ref.

## Verification

The real Docker/SSH/container-use fixture exercises exits 0/23, a fake marker, quotes,
dollar signs and multiline commands, background execution and the upstream large-output
failure. Fault injection transforms actual container-use replies to duplicate, remove
or truncate a nonce marker and drops an active transport. These cases must remain
unknown. The hold-stdout records are compared against mint's records; tests also cover
escaped/redacted previews, bounded rejection, replay and interrupted settlement.
No live GitHub-hosted lease is acquired before the coordinator's re-pin.

Run focused audit/CI-policy/workflow/transport/runner-init tests and the full repository
check in transient systemd user units capped at `MemoryMax=6G`, `MemorySwapMax=0`.
The approved reviewer decision requires polling exact-head CI and stopping for the
coordinator after D1. Do not subscribe to CI for this stage.

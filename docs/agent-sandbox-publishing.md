# Sandbox audit and PR execution

D1 is accepted and pinned at `30c864febd464f1ed91424742bbf9d74f4d1de82`.
This D2 candidate implements the canary gate, before write-token minting or real PR
publication. The coordinator must re-pin this candidate after exact-head CI before
running any lease or probe. Workers do not change production configuration, Apps,
environments, rulesets or pins.

The publish App is **ghettimonster**, App ID **5232172**, bot **339414993**
(`ghettimonster[bot]`). Its variable is `GHETTIMONSTER_APP_ID`; the eventual key is
`GHETTIMONSTER_PRIVATE_KEY`, only in the protected environment. The candidate never
references that key in its workflow or mints a token. Ben has provisioned the workflowd
canary environment; rulesets and private-key provisioning remain operator work after
the canary gate.

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

Settlement stops/revokes the session and reads the hold process acknowledgement in one
bounded SSH call. It validates all canonical records, replays only sequences after the
watermark in one bounded batch, and requires acknowledgement through the final sequence.
The overall drain limit remains 30 seconds. Missing acknowledgement refuses success;
`audit-failure.json` and the terminal diagnostic retain the exception and elapsed time.
For policies with `publish`, a successful agent completion seals its result on the
runner and ends hold normally. Other terminal outcomes clean up without approval.
No patch or bundle is downloaded to mint. Missing
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
restricted to the two reviewed, pinned setup actions and the complete SHA-256 snapshot
of `agent-image.yml`. Its caller accepts no inputs, secrets or other overrides. Any
image workflow change requires reviewing and updating that snapshot. Other local
actions and reusable workflow calls (including inherited secrets) are refused. The guard
checks effective permissions, runner class, privileged contexts, install policy and
the anonymous checkout snapshot. Its quality-matrix result feeds `Required checks`.
It rejects target/downstream privileged triggers. It cannot secure arbitrary edits
to its own implementation or repository scripts: the trust root remains the
operator-reviewed workflow snapshot and human review of workflow changes. Future
publishing must evaluate the trusted base policy before writing a ref.

The image build fetches the exact SHA anonymously. It runs the pinned, checksum-verified
Nix installer script with both token inputs removed: the composite action itself would
otherwise pass `github.token` and persist it in Nix configuration. The locked Nix build,
deterministic archive comparison and real container-use E2E remain blocking. Artifact
upload runs only on main pushes; GHCR publication retains its existing push-only gate.

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
coordinator at the canary gate. Do not subscribe to CI for this stage.

## Canary publication contract

Result tooling takes its workspace from the trusted caller's working directory.
Sealing reads `repository/` and writes `result/`; validation reads `result.zip` and
creates `validated/`. Arbitrary archive/output/repository paths are no longer CLI
parameters, and ZIP entries map to fixed output filenames. Commit identities must be
40 lowercase hexadecimal characters before entering Git arguments. Git and Python
use absolute system executable paths; the hosted-entrypoint fixture also runs with
a hostile `python3` earlier on PATH. Approval fields are compared as a set because
their order has no meaning. Git enables only HTTPS/file transports.

One residual SonarCloud finding, `AaEZv6-2dwEzUswl_4bM` (`pythonsecurity:S8705`),
has a narrow suppression on `subprocess.run` in `result.py`. Its final trace follows
the JSON `source` field through `commit_id()` into `git fetch`. That validator rejects
every non-string or value that does not fully match `[a-f0-9]{40}` before invoking Git.
The accepted value cannot contain an option prefix, whitespace, a URL or revision
operators. Fetch also places its URL and source operands after `--`; no shell is
invoked, executable paths are absolute, ambient Git configuration is disabled, and
external-helper/SSH transports are unavailable. This trace is therefore a false
positive, not an accepted argument-injection risk. The real Git/ZIP tests reject
option-like source/result IDs and an attempted external helper while accepting the
ordinary bundle and preserving arbitrary agent-selected branch data as JSON. The
other seven security/reliability findings were resolved in code. No quality gate or
project setting was changed.

A configured `publish` policy supplies the PR base ref, environment ID and publisher
App/bot IDs. `toolingSha` optionally selects the centrally reviewed reusable workflow;
it defaults to `workflowSha`. The base tip is recorded before dispatch. There is no
result branch input in policy or dispatch. The agent chooses the name and finishes with
a JSON object with `environmentId` (the exact container-use environment holding its
result) and `branch` (its chosen name). The agent works in container-use environments
and must not create Git branches inside the container or push; the publisher creates
the branch. Names pass unchanged through JSON; GitHub
will decide ref validity and collision protection when real publication is enabled.

After session quiescence and audit acknowledgement, the fixed runner control seals the
selected container-use result in `result.bundle` and `result.json`, verifying the exact
environment among `refs/remotes/container-use/*` even when several exist. Only
source/result SHAs, the name and content digests return over SSH. A missing or unknown
environment produces an explicit operator outcome without choosing another result;
an unchanged source explicitly produces no publication. The lease uploads the artifact and a fresh `agent-publish` job waits on its environment. It has Actions read
and Contents read, no Tailscale, OIDC, shared cache, inherited secrets or agent checkout.

Migration 33 stores metadata-only immutable publication intents. Approval checks the
owned run, attempt, source, workflow identity, successful runner job, immutable artifact
identity, expected custom rule and environment settings. The gate App uses a separate
repository token with Actions read and Deployments write. Approval is an exact
result-binding JSON comment. Its intent is saved before POST; a lost response is
recovered by reading the matching review, never by blindly repeating the POST. The
publisher checks the authenticated bot ID and review state, run/attempt and artifact
identity before downloading. The bootstrap deliberately fails closed if custom-only
pending deployments or custom approval comments are unavailable via these APIs.

The fresh job bounds and hashes the ZIP, permits exactly two regular entries, and
validates the manifest/bundle against the approval. A clean bare Git repository imports
the trusted source anonymously, without checking out agent code, and inspects every new
commit. Forbidden paths, hidden forbidden intermediate changes, symlinks, submodules,
mode changes, extra bundle heads, unrelated/nonlinear history and content limits fail.
Only the following step receives the harmless `PUBLISH_PROBE_CANARY`. It checks secret
presence without printing its value, then exits. There is no push or PR API in this
candidate. Ruleset enforcement, ref collision/race tests, push/PR recovery and real draft
PR receipts remain gated on the canary result and subsequent operator key/rule setup.

Pending publication retains lease custody and stops SSH heartbeats. Restart uses the
saved intent and deadline; cancellation terminates the waiting Actions run. Missing or
mismatched review evidence retains custody until reconciliation or deadline. Successful
canary, failure or cancellation still confirms Actions termination and lease-ref
absence before terminal mailbox delivery. Historical capture-only rows are not backfilled.

After the coordinator re-pin, use the existing proof environment with one repository
policy, its nonsecret Tailscale evidence and a `publish` block. The verifier uses the
existing authenticated dispatch path and takes the same explicit executor/model options
as the live verifier:

```bash
bun scripts/evidence/agent-sandbox.mjs --probe-publish --executor opencode:opencode-primary --model "$OPENCODE_MODEL"
```

Run this in a uniquely named transient user unit with `MemoryMax=6G` and
`MemorySwapMax=0`. It checks that the lease has neither the canary nor the publish key,
that the gate released only its bound result, and that the binding, Actions run and
lease ref were cleaned up. Evidence contains metadata, audit records and Actions logs,
never a downloaded patch or bundle. `--live` cannot perform real publishing in this
bootstrap candidate. A failed canary requires review; there is no manual-approval or
webhook fallback.

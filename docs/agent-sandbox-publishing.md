# Sandbox audit and PR execution

D1 is accepted and pinned at `30c864febd464f1ed91424742bbf9d74f4d1de82`.
The D2 canary gate passed at `28fcbd7` with runner pin `b28944e`. The approved
real-publication runner pin is `87aa541eeaf52754a1ad36d11b38ca08e1b43ad7`.
The D3 verifier runs from the checked candidate checkout; its changes do not alter
the runner pin. Workflow or bootstrap changes still require coordinator re-pin.

For repository setup and the short cross-owner caller, see the
[onboarding runbook](agent-sandbox-onboarding.md).

The publish App is **ghettimonster**, App ID **5232172**, bot **339414993**
(`ghettimonster[bot]`). Its variable is `GHETTIMONSTER_APP_ID`; its key is
`GHETTIMONSTER_PRIVATE_KEY`, held only in the caller's protected environment.
Ben owns key provisioning, rulesets, environment settings and deployment pins.

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
Across all workflows, only a top-level `agent-publish` job may declare an environment
or reference the secrets context. Inherited secrets and ambient workflow secret references
are always rejected, including on push-only workflows. The reusable lease workflow
has no secrets or environment. It rejects target/downstream privileged triggers.
It cannot secure arbitrary edits to its own implementation or repository scripts: the trust root remains the
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
Poll exact-head candidate CI with `gh run list --commit HEAD_SHA`. Do not subscribe
to CI for this stage. Changes to pinned tooling stop for coordinator review/re-pin.

## Protected publication contract

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
an unchanged source explicitly produces no publication. The reusable lease job uploads
the artifact and finishes. Each repository's caller owns a top-level `agent-publish`
job with `needs: sandbox`, `environment: agent-publish`, and only Actions read and
Contents read. Its separate hosted runner has no Tailscale, OIDC, shared cache or
agent checkout. The controller matches `sandbox / runner` and `agent-publish` exactly.

The caller invokes the reviewed `.github/actions/agent-publish` composite action.
Other repositories pin both the reusable workflow and action to the same exact
approved workflowd SHA; the action finds `deploy/sandbox/publish.mjs` relative to
its own installation, independent of the caller repository or working directory.
Workflowd checks out only the action and deploy tooling at its own exact `github.sha`
and uses the local action at that commit. This works across repository owners without
passing secrets through a reusable workflow. `secrets: inherit` is forbidden.

The caller passes `github.token`, the gate bot ID, App ID and
`publisher-private-key: ${{ secrets.GHETTIMONSTER_PRIVATE_KEY }}` as explicit inputs.
Only validation receives the read token. Only the token-mint step consumes the key,
after validation succeeds. Neither credential is a job/workflow environment variable.
The canary-only step is removed.

The reviewed token action is
[`actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349`](https://github.com/actions/create-github-app-token/tree/fee1f7d63c2ff003460e3d139729b119787bc349).
Review covered its entrypoints, repository installation lookup, permission input mapping,
masking, token state and post-job revocation. Explicit owner and single repository inputs
limit the installation token to the caller, with Contents write and Pull requests write
(Metadata read is implicit). Its default post-job revocation stays enabled. The composite
also runs an `always()` revoke step before returning its final receipt; revocation failure
cannot produce a successful publication receipt. Runner destruction/network failure can
prevent cleanup: no software can guarantee remote revocation in that case, and the token's
GitHub expiry remains the final bound. No key or token is stored in workflowd state.

The publisher uses a fresh validated bare repository with no inherited Git environment,
config, hooks, checkout, filters or replacement refs. A trusted ephemeral credential helper
serves only the exact caller HTTPS repository, using an environment token rather than argv
or stored Git configuration. Push output is captured and never printed. A taken name fails;
the exact validated SHA and unchanged agent branch form one explicit refspec, without force,
update, delete, tags or mirror options. Only Git's newly-created porcelain status is accepted,
then the remote ref/SHA is read back. GitHub's required update/deletion rules close the
preflight race; publication must not be enabled before those rules are verified.

The PR is created as a draft to the base bound into the approval, with
`maintainer_can_modify: false`. Readback checks its number, URL, draft/open state, author
login and ID, same-repository head/base and exact result SHA. Its small binding marker
allows recovery of a lost PR reply without repeating the POST. No result branch is deleted
or overwritten as rollback.

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

Publication receipts are metadata only. The trusted publisher emits bounded base64 JSON
records in its own job log at each stage, including before writes and after revocation.
The controller selects the exact `agent-publish` job ID from the owned run/attempt, limits
its log to 1 MiB, checks the binding, and saves only receipt metadata in migration 34's
publication table. Same-run receipt artifacts are deliberately not trusted: the lease
runner can upload artifacts too. The result bundle stays on GitHub and the publish runner.

Migration 34 binds the immutable base ref into new version-2 approvals. Historical canary
intents retain a null base and are never retroactively published. Recovery reuses stored
receipts, checks the remote head and draft PR, and never repeats a push or PR POST. An
ambiguous push without Git's creation acknowledgement remains `operator_required`, even
if a matching SHA exists remotely; ownership has not been proven. A known-created branch
with a lost PR reply can recover by exact marker, author, head and base. Missing logs,
revocation failure, foreign PRs and ambiguous ownership fail closed.

Cancellation before approval does not publish. After approval, cancellation/expiry stops
the owned Actions run and reconciles its receipt before settlement; it does not promise
rollback. A confirmed PR returns only repository, branch, result SHA, base and PR URL.
Actions termination and lease-ref deletion still precede the terminal mailbox.

## D3 live publication evidence

`scripts/evidence/agent-sandbox.mjs --live` uses the selected executor and model with
existing authentication and authenticated `dispatch_agent`. Repository tasks and exact
test commands live in `scripts/evidence/agent-sandbox-proof.json`; there are no result
branch values. An unlisted repository fails before dispatch. The agent chooses its
branch and calls `submit_result` on its owned bridge after remote tests pass.

Provide exactly one approved repository policy in `WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES`,
the operator record in `EVIDENCE_TAILSCALE_TRUST_FILE`, the existing authenticated
executor endpoint/password in `EVIDENCE_OPENCODE_URL` / `EVIDENCE_OPENCODE_PASSWORD`,
and a distinct durable `EVIDENCE_SANDBOX_ROOT` for each gate. The configured publication
base is also the dispatch source; its exact tip is recorded before work begins.
Never place credentials on the command line or copy model credentials.

After a trivial authenticated inference succeeds for that exact model, run each command
separately from the candidate checkout in a transient systemd user unit with
`MemoryMax=6G`, `MemorySwapMax=0`:

```sh
bun scripts/evidence/agent-sandbox.mjs --live --executor opencode:opencode-primary --model zai-coding-plan/glm-5.3-flash
bun scripts/evidence/agent-sandbox.mjs --live --executor codex:local --model gpt-6-astra
bun scripts/evidence/agent-sandbox.mjs --live --executor claude:local --model claude-opus-5-5
```

Run them one at a time. A Claude authentication failure is recorded separately; it does
not turn an unrun Claude gate into a pass. Never substitute Fable. An existing receipt
in the same evidence directory resumes that run rather than dispatching another one.

Success requires the bound `submit_result` receipt and matching owned tool call,
passing remote tests, the exact custom-rule approval, and a successful `agent-publish`
job from the recorded run/attempt. Only that job's log supplies publisher receipts.
Its final receipt must confirm the published PR and token revocation. GitHub readback
must show the agent-selected ref at the sealed result SHA and an **open draft** PR
by `ghettimonster[bot]` (339414993), with the same repository, recorded base and
`maintainer_can_modify: false`. Matching immutable PR base/head SHAs proves equality
to the sealed source/result diff without downloading a patch or bundle. If the base
has moved, verification stops rather than claiming that the diff still matches.

The verifier compares every canonical audit record with the runner job's timestamped
Actions lines and its final acknowledgement. It requires released lease custody,
revoked binding, absent bridge, quiescent session, independently observed lease-ref
404, and exactly one completed mailbox message. Proof PRs are left open and unmerged.
`probe.json` records timings, SHAs, run/PR URLs and terminal diagnostics;
`publication.json`, `audit.json`, `runner.log`, `tool-evidence.json` and Actions logs
retain the supporting evidence. Failures retain the exception and cleanup evidence.
The historical `--probe-publish` mode continues to require the canary receipt; it is
not a substitute for a live gate.

Only workflowd is currently listed in the proof-task registry. Other repositories need
approved onboarding and an appropriate task before their gate can run. The broader
D3 plan still requires a separately authorized provenance receipt and independent
Claude security review before merge. No GitHub settings, rulesets or secrets are
changed by the verifier.
